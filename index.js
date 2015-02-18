// Description:
//   Train brobbot to react to certain terms.
//
// Dependencies:
//   lodash: ~2.4.1
//   natural: ~0.1.28
//   moment: ~2.8.3
//   q: ~1.1.2
//
// Configuration:
//   BROBBOT_REACT_STORE_SIZE=N - Remember at most N messages (default 200).
//   BROBBOT_REACT_THROTTLE_EXPIRATION=N - Throttle responses to the same terms for N seconds (default 300).
//   BROBBOT_REACT_INIT_TIMEOUT=N - wait for N milliseconds for brain data to load from redis. (default 10000)
//
// Author:
//   b3nj4m

var _ = require('lodash');
var natural = require('natural');
var moment = require('moment');
var Q = require('q');

var stemmer = natural.PorterStemmer;
var ngrams = natural.NGrams.ngrams;

var STORE_SIZE = process.env.BROBBOT_REACT_STORE_SIZE ? parseInt(process.env.BROBBOT_REACT_STORE_SIZE) : 200;
var THROTTLE_EXPIRATION = process.env.BROBBOT_REACT_THROTTLE_EXPIRATION ? parseInt(process.env.BROBBOT_REACT_THROTTLE_EXPIRATION) : 300;
var INIT_TIMEOUT = process.env.BROBBOT_REACT_INIT_TIMEOUT ? parseInt(process.env.BROBBOT_REACT_INIT_TIMEOUT) : 10000;

var MESSAGE_TABLE = 'messages';
var RESPONSE_USAGE_TABLE = 'response-usages';
var TERM_SIZES_TABLE = 'term-sizes';

var lastUsedResponse = null;

var successTmpl = _.template('Reacting to <%= term %> with <%= response %>');
var responseTmpl = _.template('<%= response %>');
var ignoredTmpl = _.template('No longer reacting to <%= term %> with <%= response %>');
var lastResponseNotFoundTmpl = _.template('Wat.');

function randomItem(list) {
  return list[_.random(list.length - 1)];
}

function randomItems(list, count) {
  if (typeof count === 'undefined') {
    return list;
  }
  else if (count === 1) {
    return randomItem(list);
  }

  var result = [];
  var copy = list.slice();
  for (var i = 0; i < count; i++) {
    result.push(copy.splice(_.random(copy.length - 1), 1)[0]);
  }

  return result;
}

function responseToString(response) {
  return responseTmpl(response);
}

function successMessage(response) {
  return successTmpl(response);
}

function ignoredMessage(response) {
  return ignoredTmpl(response);
}

function lastResponseNotFoundMessage() {
  return lastResponseNotFoundTmpl();
}

module.exports = function(robot) {
  function incrementTermSize(response) {
    return robot.brain.hincrby(TERM_SIZES_TABLE, response.stems.length.toString(), 1).then(_.constant(response));
  }

  function decrementTermSize(response) {
    return robot.brain.hincrby(TERM_SIZES_TABLE, response.stems.length.toString(), -1).then(_.constant(response));
  }

  function ensureStoreSize() {
    var result = Q.apply(this, arguments);

    var getKeys = robot.brain.keys(messageKey(''));

    var computeSize = getKeys.then(function(keys) {
      return Q.all(_.map(keys, function(key) {
        return robot.brain.scard(key);
      })).then(function(sizes) {
        return _.reduce(sizes, function(memo, value) {
          return memo + value;
        }, 0);
      });
    });

    return Q.all([computeSize, getKeys]).spread(function(size, keys) {
      if (size > STORE_SIZE) {
        return Q.all(_.map(keys, function(key) {
          return robot.brain.scard(key);
        })).then(function(sizes) {
          return Q.all(_.times(size - STORE_SIZE, function() {
            if (sizes.length !== 0) {
              var idx = _.random(keys.length - 1);
              var key = keys[idx];

              sizes[idx]--;

              if (sizes[idx] === 0) {
                sizes = sizes.splice(idx, 1);
              }

              return robot.brain.spop(key);
            }
          }));
        });
      }
    }).then(_.constant(result));
  }

  function add(term, response) {
    //only use stemmer for things that look like words
    var stems = /^[\w\s]+$/i.test(term) ? stemmer.tokenizeAndStem(term) : [];
    var stemsString = stems.join(',') || term.toLowerCase();

    var item = {
      stems: stems,
      stemsString: stemsString,
      term: term,
      response: response
    };

    return robot.brain.sadd(messageKey(stemsString), item)
      .then(incrementTermSize.bind(this, item))
      .then(ensureStoreSize);
  }

  function getAllResponses() {
    return robot.brain.keys(messageKey('*')).then(function(keys) {
      var promises = Q.all(_.map(keys, function(key) {
        return robot.brain.smembers(key);
      }));
      
      return promises.then(function(responses) {
        return _.transform(responses, function(result, key, value) {
          result[value].stemsString = value;
        });
      });
    });
  }

  function getAllTermSizes() {
    return robot.brain.hgetall(TERM_SIZES_TABLE);
  }

  function messageKey(key) {
    return MESSAGE_TABLE + ':' + key;
  }

  function responseUsageKey(string) {
    return RESPONSE_USAGE_TABLE + ':' + string;
  }

  function responseShouldBeThrottled(searchString) {
    return robot.brain.get(responseUsageKey(searchString)).then(function(lastUsed) {
      return lastUsed ? moment.utc(lastUsed).add(THROTTLE_EXPIRATION, 'seconds').isAfter() : false;
    }, function() {
      return false;
    });
  }

  function get(text) {
    text = text.toLowerCase();
    var stems = stemmer.tokenizeAndStem(text);

    return getAllTermSizes().then(function(termSizes) {
      var promises = _.map(termSizes, function(count, size) {
        var promises;
        size = parseInt(size);

        if (count > 0) {
          if (size > 0) {
            //generate ngrams for sizes for which there are terms to react to
            promises = _.map(ngrams(stems, size), function(ngram) {
              ngramString = ngram.join(',');

              return robot.brain.exists(messageKey(ngramString)).then(function(exists) {
                if (exists) {
                  return responseShouldBeThrottled(ngramString).then(function(shouldBeThrottled) {
                    if (shouldBeThrottled) {
                      return null;
                    }
                    else {
                     return robot.brain.srandmember(messageKey(ngramString));
                    }
                  });
                }
                else {
                  return null;
                }
              });
            });

            return Q.all(promises).then(function(responses) {
              return _.compact(responses);
            });
          }
          //test exact matches
          else if (size === 0) {
            return robot.brain.keys(messageKey('*')).then(function(keys) {
              keys = _.filter(keys, function(keys) {
                return text.indexOf(key) > -1;
              });

              promises = _.map(keys, function(key) {
                return robot.brain.srandmember(key);
              });

              return Q.all(promises);
            });
          }
        }

        return null;
      });

      return Q.all(promises).then(function(responseGroups) {
        return randomItem(_.flatten(_.compact(responseGroups)));
      });
    });
  }

  function del(response) {
    return robot.brain.srem(messageKey(response.stemsString), response).then(decrementTermSize.bind(this, response));
  }

  function responseUsed(response) {
    lastUsedResponse = response;
    return robot.brain.set(responseUsageKey(response.stemsString), moment.utc().toISOString());
  }

  function init(robot) {
    return ensureStoreSize();
  }

  function start(robot) {
    robot.helpCommand('brobbot react <term> <response>', 'tell brobbot to react with <response> when it hears <term> (single word)');
    robot.helpCommand('brobbot react "<term>" <response>', 'tell brobbot to react with <response> when it hears <term> (multiple words)');
    robot.helpCommand('brobbot ignore that', 'tell brobbot to forget the last <term> <response> pair that was uttered.');

    robot.logger.info('starting brobbot react...');

    robot.respond(/react (([^\s]*)|"([^"]*)") (.*)/i, function(msg) {
      var term = msg.match[2] || msg.match[3];
      var response = msg.match[4];

      return add(term, response).then(function(responseObj) {
        msg.send(successMessage(responseObj));
      });
    });

    robot.respond(/ignore that/i, function(msg) {
      var ignored = false;

      var done = function(ignored) {
        if (ignored) {
          msg.send(ignoredMessage(lastUsedResponse));
        }
        else {
          msg.send(lastResponseNotFoundMessage());
        }

        lastUsedResponse = null;
        return Q();
      };

      if (lastUsedResponse) {
        return del(lastUsedResponse).then(done);
      }
      else {
        return done(ignored);
      }
    });

    robot.hear(/.+/, function(msg) {
      var text = msg.message.text;

      if (!msg.isAddressedToBrobbot) {
        return get(text).then(function(response) {
          if (response) {
            msg.send(responseToString(response));
            lastUsedResponse = response;
            responseUsed(response);
          }
        });
      }
    });
  }

  return init(robot).then(start.bind(this, robot));
};
