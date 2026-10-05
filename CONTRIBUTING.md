# Contributing to Countertop

Countertop is small on purpose: a browser MCP host, an MCP Apps host, a voice layer and one serverless function. Changes that keep it small are the easiest to accept.

## Set up

```bash
npm install
npm run dev        # http://localhost:5173
```

The tool console works without any key. For model turns, run the function locally with the Vercel CLI (`vercel dev`) and set `AWS_BEARER_TOKEN_BEDROCK` in `.env.local`, or point the page at a deployment of your own.

## Before you open a pull request

- `npm run build` passes (it type-checks first).
- Try the end-to-end script against a deployment or `vercel dev`: `node scripts/e2e.cjs http://localhost:3000 https://lowtide-energy.vercel.app/api/mcp`.
- Test against at least one server that ships an MCP App view and one that doesn't.
- Keep the page working with the keyboard only, and with "Speak replies" off.

## Good first contributions

- Host context: let the tester pick a screen size and theme (Echo Show 5, 8, 15) and send `containerDimensions` and `theme` changes to the view.
- Transcript export: download a session (utterances, tool calls, results, replies) as JSON for bug reports.
- Elicitation and sampling: show when a server asks the host for input, and let the tester answer.
- Other model providers behind `api/turn.mjs`, keeping the same request and response shape.
- Auth: send a bearer token or custom headers to servers that need them (the field exists in `connect()`).

## Reporting bugs

Open an issue with the server URL (or a minimal server), the utterance or tool call, what you expected and what happened, and the browser. Screenshots of the device screen help.

## Licence

By contributing you agree that your contributions are licensed under the MIT licence in this repository.
