# Remy App Clip

This is the native path for Remy payment links.

Goal:

```text
https://trymomento.app/pay?friend=alex&amount=28.67&title=Dinner
```

- opens the Remy App Clip if available
- opens the full Remy app if installed
- falls back to the web `/pay` sheet otherwise

## Setup

1. Confirm `trymomento.app` is the Associated Domain in `project.yml`.
2. Confirm `DEVELOPMENT_TEAM` in `project.yml` is `QCW9XJC54W`.
3. Set these backend env vars for the Apple association file:

```bash
APPLE_APP_ID_PREFIX=QCW9XJC54W
IOS_APP_BUNDLE_ID=com.lstsk.remy
IOS_APP_CLIP_BUNDLE_ID=com.lstsk.remy.Clip
PUBLIC_APP_URL=https://trymomento.app
```

4. Serve the backend from real HTTPS on that domain.
5. Confirm this works:

```bash
curl https://trymomento.app/.well-known/apple-app-site-association
```

6. Run:

```bash
npm run ios:generate
open ios/Remy.xcodeproj
```

7. In Apple Developer / App Store Connect, configure the App Clip experience for `/pay`.

Without the Apple domain + bundle configuration, links will keep opening in the browser.
