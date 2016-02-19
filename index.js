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
//   BROBBOT_REACT_THROTTLE_EXPIRATION=N - Throttle responses to the same terms for a minimum of N seconds (default 300).
//   BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER=N - Set the multiplier used in the frequency-based throttling calculation
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
var THROTTLE_FREQUENCY_MULTIPLIER = process.env.BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER ? parseFloat(process.env.BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER) : 10;
var HALF_THROTTLE_FREQUENCY_MULTIPLIER = THROTTLE_FREQUENCY_MULTIPLIER / 2;

var MESSAGE_TABLE = 'messages';
var NO_STEM_MESSAGE_TABLE = 'no-stem-messages';
var RESPONSE_USAGE_TABLE = 'response-usages';
var TERM_USAGE_TABLE = 'term-usage';
var MESSAGE_COUNT_KEY = 'message-count';

var messageTableRegex = new RegExp('^' + MESSAGE_TABLE + ':');
var noStemMessageTableRegex = new RegExp('^' + NO_STEM_MESSAGE_TABLE + ':');

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
  return /\b[\w]{2,}\b/i.test(str);
}

module.exports = function(robot) {
  function ensureStoreSize() {
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
    });
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

    var key = isWords ? messageKey(stemsString) : noStemMessageKey(stemsString);

    return robot.brain.sadd(key, item).then(ensureStoreSize).then(function() {
      return item;
    });
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

  function termUsageKey(term) {
    return TERM_USAGE_TABLE + ':' + term;
  }

  function messageKey(key) {
    return MESSAGE_TABLE + ':' + key;
  }

  function noStemMessageKey(key) {
    return NO_STEM_MESSAGE_TABLE + ':' + key;
  }

  function responseUsageKey(string) {
    return RESPONSE_USAGE_TABLE + ':' + string;
  }

  function responseShouldBeThrottled(searchString) {
    return Q.all([
      robot.brain.get(responseUsageKey(searchString)),
      robot.brain.get(termUsageKey(searchString)),
      robot.brain.get(MESSAGE_COUNT_KEY)
    ]).spread(function(lastUsed, termCount, totalCount) {
      totalCount = totalCount ? parseInt(totalCount) : 1;
      termCount = termCount ? parseInt(termCount) : 0;

      var multiplier = Math.pow(THROTTLE_FREQUENCY_MULTIPLIER, (totalCount + termCount) / totalCount) - HALF_THROTTLE_FREQUENCY_MULTIPLIER;

      return lastUsed ? moment.utc(lastUsed).add(Math.round(THROTTLE_EXPIRATION * multiplier), 'seconds').isAfter() : false;
    }, function(err) {
      return false;
    });
  }

  function getResponse(text) {
    return search(text).then(function(results) {
      var responses = Q.all(_.compact(_.map(results, function(result) {
        return responseShouldBeThrottled(result.term).then(function(shouldBeThrottled) {
          if (shouldBeThrottled) {
            return null;
          }
          else {
           return robot.brain.srandmember(result.key);
          }
        });
      }))).then(function(responseGroups) {
        return randomItem(responseGroups);
      });

      return Q.all([responses, incrementTermCounts(results)]).then(function(results) {
        return results[0];
      });
    });
  }

  function search(text) {
    text = text.toLowerCase();
    var stems = stemmer.tokenizeAndStem(text);
    var stemPromises;

    if (looksLikeWords(text)) {
      stemPromises = _.flatten(_.map(stems, function(stem, idx) {
        return robot.brain.keys(messageKey(stem)).then(function(keys) {
          keys = _.filter(keys, function(key, idx2) {
            var keyStems = key.replace(messageTableRegex, '').split(',');

            //not enough words left to trigger this term
            if (keyStems.length > stems.length - idx) {
              return false;
            }

            for (var i = 0; i < keyStems.length; i++) {
              if (stems[idx + i] !== keyStems[i]) {
                return false;
              }
            }

            return true;
          });

          return _.map(keys, function(key) {
            return {term: key.replace(messageTableRegex, ''), key: key};
          });
        });
      }), true);
    }
    else {
      stemPromises = Q.resolve([]);
    }

    //search non-word terms using substring match
    var noStemPromise = robot.brain.keys(noStemMessageKey('')).then(function(keys) {
      keys = _.filter(keys, function(key) {
        var termString = key.replace(noStemMessageTableRegex, '');
        return text.indexOf(termString) > -1;
      });

      return _.map(keys, function(key) {
        return {term: key.replace(noStemMessageTableRegex, ''), key: key};
      });
    });

    return Q.all([noStemPromise].concat(stemPromises)).then(function(results) {
      return results[0].concat.apply(results[0], _.rest(results));
    });
  }

  function del(response) {
    return Q.all([
      robot.brain.srem(messageKey(response.stemsString), response),
      robot.brain.srem(noStemMessageKey(response.stemsString), response)
    ]);
  }

  //TODO use message count rather than time
  function responseUsed(response) {
    lastUsedResponse = response;
    return robot.brain.set(responseUsageKey(response.stemsString), moment.utc().toISOString());
  }

  function incrementMessageCount() {
    //increment the total message count
    return robot.brain.incrby(MESSAGE_COUNT_KEY, 1);
  }

  function incrementTermCounts(results) {
    //increment the count for terms which have responses
    return Q.all(_.map(results, function(result) {
      return robot.brain.incrby(termUsageKey(result.term), 1);
    }));
  }

  function init(robot) {
    return ensureStoreSize();
  }

  function start(robot) {
    robot.helpCommand('brobbot react `term` `response`', 'tell brobbot to react with `response` when it hears `term` (single word)');
    robot.helpCommand('brobbot react "`term`" `response`', 'tell brobbot to react with `response` when it hears `term` (multiple words)');
    robot.helpCommand('brobbot what was that', 'ask brobbot about the last `response` uttered.');
    robot.helpCommand('brobbot ignore that', 'tell brobbot to forget the last `term` `response` pair that was uttered.');

    robot.respond(/react ("([^"]*)"|([^\s]*)) (.*)/i, function(msg) {
      var term = msg.match[2] || msg.match[3];
      var response = msg.match[4];

      return add(term, response).then(function(responseObj) {
        msg.send(successMessage(responseObj));
      }).fail(function(err) {
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

      if (!msg.message.isBrobbotCommand) {
        var get = getResponse(text).then(function(response) {
          if (response) {
            msg.send(responseToString(response));
            return responseUsed(response);
          }
        });

        return Q.all([get, incrementMessageCount()]);
      }
    });
  }

  return init(robot).then(start.bind(this, robot));
};
