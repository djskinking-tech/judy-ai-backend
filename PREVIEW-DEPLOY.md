# JUDY AI V2.2 Preview Worker

This configuration is deliberately separate from production.

- Worker name: `judy-ai-v22-preview`
- Config: `wrangler.preview.jsonc`
- No production KV namespace is bound.
- No scheduled Cron trigger is configured.
- Production Worker name and configuration are unchanged.

## Deploy from the V2.2 branch

Run from the repository root while checked out to `experiment/prediction-v22`:

```sh
npx wrangler secret put SPORTMONKS_API_TOKEN --config wrangler.preview.jsonc
npx wrangler deploy --config wrangler.preview.jsonc
```

Enter the Sportmonks token only at the Wrangler secret prompt. Never commit it or paste it into chat.

Alternatively, create a separate Worker in the Cloudflare dashboard named `judy-ai-v22-preview`, connect the repository using branch `experiment/prediction-v22`, and use `wrangler.preview.jsonc` as its configuration. Add `SPORTMONKS_API_TOKEN` as an encrypted secret on that preview Worker only.

Do not bind the production `JUDY_PREDICTIONS` KV namespace to the preview. The historical backtest route does not need prediction storage. The preview is for testing the experimental backtest only; do not route live users to it.

After deployment, test one previously completed fixture first, then test a few more dates slowly to avoid provider rate limits. Keep the live production Worker untouched until the results have been reviewed.
