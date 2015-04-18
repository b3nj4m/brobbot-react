### brobbot-react

Train brobbot to react to certain terms. Multiple responses to the same term are allowed. One will be selected at-random.

```
Bob: brobbot react homestar seriously.
Brobbot: reacting to homestar with seriously.
...
Alice: Homestar Runner is the best.
Brobbot: seriously.
```

### Matching

It currently uses [natural](https://github.com/NaturalNode/natural)'s `PorterStemmer` to match words regardless of conjugation, tense, etc. This is almost certainly going to change as I experiment with it more.

### Throttling

Responses to the same term will be throttled according to how often a message including the term is seen. Specifically, the throttle expiration time is proportional to the frequency of the term.

```
timeToThrottle = ((totalMessageCount + termUsageCount) / totalMessageCount) * throttleMultiplier
```

### Configuration

#### Store size

Remember at most `N` messages (default 200).

```
BROBBOT_REACT_STORE_SIZE=N
```

#### Throttle expiration

Minimum time, `N`, to throttle responses to the same terms in seconds (default 300).

```
BROBBOT_REACT_THROTTLE_EXPIRATION=N
```

#### Throttle frequency multiplier

Multiplier used to tweak the computed throttle times (default 2).

```
BROBBOT_REACT_THROTTLE_FREQUENCY_MULTIPLIER=N
```

### Commands

#### React (single-word term)

Tell brobbot to react with `<response>` when it hears `<term>`.

```
brobbot react <term> <response>
```

#### React (multi-word term)

Tell brobbot to react with `<response>` when it hears `<term>`.

```
brobbot react "<term>" <response>
```

#### What was that

Ask brobbot about the last `<response>` uttered.

```
brobbot what was that
```

#### Ignore

Tell brobbot to forget the last `<term>` `<response>` pair that was uttered.

```
brobbot ignore that
```

