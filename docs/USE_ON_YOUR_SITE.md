# Use Homerun on your site

Open **Use on your site** at the bottom of the Founder Haus demo or the creation flow. Copy the AI instructions or download the Markdown file. The brief includes the current settings and can be pasted into the coding assistant working on your website. Changing the draft or demo inputs updates the next copied brief.

## Build in your own branding

Ask your assistant to integrate a compact asset card, fundraising progress, contribution action and FUND/INCOME explanation into your existing site or dashboard. Keep the simulator optional. Use your own brand and cover images; Homerun can remain a detailed reference.

Source: https://github.com/mejango/homerun
Demo: https://homerun.money/founderhaus

Start with `web/network-model.mjs` (projections), `web/create-model.mjs` (draft schema), `web/pay-panel.mjs` (payment previews), `web/project-journey.mjs` (stages), and `docs/NETWORK_DESIGN.md` (mechanics and limits). Inspect licensing and image source notes before reuse.

## Embed the existing demo

```html
<iframe
  src="https://homerun.money/founderhaus"
  title="Homerun asset funding simulator"
  loading="lazy"
  style="width:100%;height:900px;border:0"
></iframe>
```

This embeds the full simulator and retains Homerun branding. There is no supported theme, project-config query parameter, automatic iframe height message, or cross-origin data API. Adjust the height to fit your page. Build natively for custom branding and your own project data.

## Current integration boundary

This repository is a frontend prototype. It does not deploy the described contract system or execute wallet transactions. Its setup JSON is a draft, not a list of deployed contracts. `/project?id=...` previews are saved in localStorage and are specific to the browser and origin that created them. Copy the settings into your own data store rather than sharing that local URL.

Live integration needs verified chain/project IDs, contract addresses and ABIs, current rulesets, real balances, wallet signing and transaction simulation. The on-chain configuration and permissions must be reviewed separately; the asset budget and operating reserve do not automatically configure withdrawal allowances.

For off-chain contributions, the intended workflow settles off-chain, issues their FUND only after a successful campaign, and refunds failed campaigns off-chain. The production minting path must enforce authorization, agreed amounts and duplicate prevention.
