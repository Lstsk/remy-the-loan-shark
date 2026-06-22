# Remy iMessage Extension

This scaffold is the native contact-matching piece.

The backend cannot read a user's iPhone Contacts. The iMessage extension can ask for Contacts permission on-device, search possible matches, and send the selected contact back to Remy.

## Generate Project

```bash
npm run ios:generate
```

Open `Remy.xcodeproj` in Xcode, set your development team, and run the `RemyMessagesExtension` target.

On a real phone, `127.0.0.1` means the phone, not your Mac. Run Remy locally and expose the Hono API with an HTTPS tunnel:

```bash
npm start
ngrok http 8787
```

Then set `REMY_API_BASE_URL` in `ios/project.yml` to the ngrok HTTPS URL and regenerate the project.

## Flow

1. Remy needs contacts for `James, Boxiang`.
2. Native Messages extension opens a compact contact matching view.
3. User taps the native Contact Access Button result or chooses the right saved match.
4. Extension POSTs selected contact info to `POST /contacts`.
5. Backend saves aliases and links them to the current expense.
