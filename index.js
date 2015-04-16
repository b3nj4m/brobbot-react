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
var THROTTLE_FREQUENCY_MULTIPLIER = process.env.BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER ? parseInt(process.env.BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER) : 1;

var MESSAGE_TABLE = 'messages';
var RESPONSE_USAGE_TABLE = 'response-usages';
var TERM_SIZES_TABLE = 'term-sizes';
var TERM_USAGE_TABLE = 'term-usage';
var MESSAGE_COUNT_KEY = 'message-count';

var messageTableRegex = new RegExp('^' + MESSAGE_TABLE + ':');

var lastUsedResponse = null;

var whatTmpl = _.template('That was "<%= response %>", triggered by something like "<%= term %>"');
var successTmpl = _.template('Reacting to <%= term %> with <%= response %>');
var failureTmpl = _.template('"<%= term %>" is too trivial.');
var responseTmpl = _.template('<%= response %>');
var ignoredTmpl = _.template('No longer reacting to <%= term %> with <%= response %>');
var lastResponseNotFoundTmpls = [_.template('Wat.'), _.template("I didn't say nothin'")];

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

function whatMessage(response) {
  return whatTmpl(response);
}

function successMessage(response) {
  return successTmpl(response);
}

function failureMessage(term) {
  return failureTmpl({term: term});
}

function ignoredMessage(response) {
  return ignoredTmpl(response);
}

function lastResponseNotFoundMessage() {
  return lastResponseNotFoundTmpls[_.random(lastResponseNotFoundTmpls.length - 1)]();
}

function looksLikeWords(str) {
  return /^[\w\s]+$/i.test(str);
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
    var isWords = looksLikeWords(term);
    var stems = isWords ? stemmer.tokenizeAndStem(term) : [];

    if (isWords && stems.length === 0) {
      return Q.reject(term);
    }

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

  function termUsageKey(term) {
    return TERM_USAGE_TABLE + ':' + term;
  }

  function messageKey(key) {
    return MESSAGE_TABLE + ':' + key;
  }

  function responseUsageKey(string) {
    return RESPONSE_USAGE_TABLE + ':' + string;
  }

  function responseShouldBeThrottled(searchString) {
    return robot.brain.get(responseUsageKey(searchString)).then(function(lastUsed) {
      var timeoutExpired = lastUsed ? moment.utc(lastUsed).add(THROTTLE_EXPIRATION, 'seconds').isBefore() : true;
      if (!timeoutExpired) {
        return false;
      }
      else {
        return Q.all([
          robot.brain.get(termUsageKey(searchString)),
          robot.brain.get(MESSAGE_COUNT_KEY)
        ]).spread(function(termCount, totalCount) {
          //TODO maths
          return;
        });
      }
    }, function() {
      return false;
    });
  }

  function get(text) {
    return search(text).then(function(results) {
      return Q.all(_.compact(_.map(results, function(ngramString) {
        return responseShouldBeThrottled(ngramString).then(function(shouldBeThrottled) {
          if (shouldBeThrottled) {
            return null;
          }
          else {
           return robot.brain.srandmember(messageKey(ngramString));
          }
        });
      }))).then(function(responseGroups) {
        return randomItem(responseGroups);
      });
    });
  }

  function search(text) {
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
              var ngramString = ngram.join(',');

              return robot.brain.exists(messageKey(ngramString)).then(function(exists) {
                if (exists) {
                  return ngramString;
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
              return _.compact(_.map(keys, function(key) {
                var termString = key.replace(messageTableRegex, '');
                return text.indexOf(termString) > -1;
              }));
            });
          }
        }

        return null;
      });

      return Q.all(promises).then(function(responseGroups) {
        return _.flatten(_.compact(responseGroups));
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

  function incrementMessageCount() {
    //increment the total message count
    return robot.brain.incrby(MESSAGE_COUNT_KEY, 1);
  }

  function incrementTermCounts() {
    //increment the count for relevant terms
    //TODO only count terms for which there are responses?
    //TODO keep set of terms with responses?
    return search(text).then(function(termStrings) {
      return Q.all(_.map(termStrings, function(term) {
        return robot.brain.incrby(termUsageKey(term), 1);
      });
    });
  }

  function init(robot) {
    return ensureStoreSize();
  }

  function start(robot) {
    robot.helpCommand('brobbot react `term` `response`', 'tell brobbot to react with `response` when it hears `term` (single word)');
    robot.helpCommand('brobbot react "`term`" `response`', 'tell brobbot to react with `response` when it hears `term` (multiple words)');
    robot.helpCommand('brobbot what was that', 'ask brobbot about the last `response` uttered.');
    robot.helpCommand('brobbot ignore that', 'tell brobbot to forget the last `term` `response` pair that was uttered.');

    robot.respond(/react (([^\s]*)|"([^"]*)") (.*)/i, function(msg) {
      var term = msg.match[2] || msg.match[3];
      var response = msg.match[4];

      return add(term, response).then(function(responseObj) {
        msg.send(successMessage(responseObj));
      }).fail(function(term) {
        msg.send(failureMessage(term));
      });
    });

    robot.respond(/^what was that/i, function(msg) {
      if (lastUsedResponse) {
        msg.send(whatMessage(lastUsedResponse));
      }
      else {
        msg.send(lastResponseNotFoundMessage());
      }
    });

    robot.respond(/^ignore that/i, function(msg) {
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

      if (!msg.message.isAddressedToBrobbot) {
        var getResponse = get(text).then(function(response) {
          if (response) {
            msg.send(responseToString(response));
            return responseUsed(response);
          }
        });

        return Q.all([getResponse, incrementMessageCount(), incrementTermCounts(text)]);
      }
    });
  }

  return init(robot).then(start.bind(this, robot));
};
