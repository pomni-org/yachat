# Design QA — YaChat Digital ID

## Result

**blocked**

The reference is the supplied “Госуслуги / Цифровой ID” settings card screenshot. The implementation target is the authenticated YaChat settings screen at `https://yachat.vercel.app/`.

## What was verified

- The new “котослуги / Цифровой ID” control is inserted before the profile settings item.
- The control reuses YaChat’s shipped brand PNG and existing chevron asset rather than a drawn placeholder.
- The detail screen uses the existing settings typography, spacing, dark/light tokens, and navigation behavior.
- The ID state covers loading, retry, copy confirmation, unavailable state, and the developer documentation link.
- Frontend syntax checks and the Vercel production build pass.

## Blocker

The settings screen is protected by a YaChat account session. The available QA browser does not expose an authentication capability, so a same-viewport screenshot of the authenticated implementation could not be captured and placed beside the supplied reference. No credentials or OTP were requested or bypassed.

## Manual acceptance check

At the authenticated settings screen, confirm that the first card reads “котослуги” and “Цифровой ID”, then open it and confirm a stable masked code in the `XXX — XXX` layout.
