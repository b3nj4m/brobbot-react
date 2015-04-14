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

### Configuration

#### Store size

Remember at most `N` messages (default 200).

```
BROBBOT_REACT_STORE_SIZE=N
```

#### Throttle expiration

Throttle responses to the same terms for `N` seconds (default 300).

```
BROBBOT_REACT_THROTTLE_EXPIRATION=N
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

