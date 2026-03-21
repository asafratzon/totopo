# Contributing to totopo

Contributions are welcome - whether it's a bug report, a feature request, or a pull request.

## Reporting issues & requesting features

If you run into something unexpected or have an idea for an improvement, feel free to [open an issue](../../issues). There's no formal template — just describe what you encountered or what you'd like to see.

## Pull requests

Pull requests are welcome. To contribute:

1. Fork the repository
2. Create a branch for your change
3. Make your changes
4. Open a pull request with a clear description of what you did and why

For larger changes, it's worth opening an issue first to discuss the direction before investing time in the implementation.

## Maintainer notes

### Recording terminal GIFs

Install the required tools:

```bash
brew install asciinema
brew install agg
```

Record a session:

```bash
asciinema rec demo.cast
# do your thing, then Ctrl+D or exit to stop
```

Convert to GIF:

```bash
agg demo.cast demo.gif

# useful options:
agg --cols 120 --rows 30 demo.cast demo.gif   # set terminal dimensions
agg --speed 2 demo.cast demo.gif               # speed up slow parts (e.g. Docker build)
agg --theme monokai demo.cast demo.gif         # change color theme
```

Place final GIFs in `.github/assets/` and uncomment the relevant placeholder in `README.md`.