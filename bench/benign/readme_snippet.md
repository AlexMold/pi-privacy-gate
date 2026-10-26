# project-tools

A CLI toolkit for managing release artifacts.

## Usage

```bash
project-tools build --target linux-x64
project-tools publish --registry internal
```

## Configuration

The tool reads `~/.config/project-tools.json`. Supported keys: `registry`,
`parallelism` (default 4), `cache_ttl_seconds` (default 300).

## Development

Run `npm test`. TypeScript, ESM, zero runtime dependencies.
