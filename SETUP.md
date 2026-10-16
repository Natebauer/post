# Connecting Post to Gmail

Post talks to Gmail directly from your PC using **your own** Google OAuth client. Google requires this for any app that
reads Gmail. The setup is one-time and takes about 10 minutes. Nothing passes through a third-party server.

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the Gmail account you want to use.
2. Open the project picker at the top left and choose **New project**. Name it something like `Post Mail`, then click **Create**.
3. Make sure the new project is selected in the project picker.

## 2. Enable the APIs

1. Go to **APIs & Services → Library**.
2. Search for **Gmail API**, open it, and click **Enable**.
3. Go back to the Library, search for **People API**, and click **Enable**. Post uses it for contact autocomplete and contact photos.
4. Go back to the Library once more, search for **Google Calendar API**, and click **Enable**. Post uses it for the
   calendar on its Home screen (read-only).

## 3. Configure the consent screen

Open **Google Auth Platform**, which some consoles still label **APIs & Services → OAuth consent screen**.

1. Click **Get started** and fill in:
   - **App name:** `Post`
   - **User support email:** your address
   - **Audience:** **External**
   - **Contact email:** your address
2. Accept the policy and click **Create**.
3. Under **Data Access**, click **Add or remove scopes** and add these four scopes, then click **Save**:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/contacts.other.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`
4. Under **Audience**:
   - Add your Gmail address as a **test user**.
   - Click **Publish app** and confirm. The publishing status should now read **In production**.

> **Why publish?** In *Testing* mode, Google expires your sign-in every 7 days. Once published, your sign-in persists.
> The app stays unverified, which is fine for personal use: Google just shows a warning on first sign-in (step 5).
> You don't need to submit anything for verification.

## 4. Create the OAuth client

1. Under **Clients**, which some consoles label **Credentials → Create credentials → OAuth client ID**, click **Create client**.
2. Set **Application type** to **Desktop app** and name it `Post desktop`.
3. Click **Create**, then copy the **Client ID** and **Client secret**.

## 5. Connect Post

1. Launch Post and paste the Client ID and Client secret, then click **Continue**.
2. Click **Sign in with Google**. Your browser opens to Google's sign-in page.
3. Choose your account. Google warns **"Google hasn't verified this app"**. Click **Advanced**, then **Go to Post (unsafe)**.
   It's your own app, so this is expected.
4. Tick every permission checkbox and click **Continue**. Post needs all of them to read, send and organize mail.
5. Return to Post. It offers two optional extras (both also in Settings later): an Anthropic API key to turn on the
   AI features, and making Post your default email app. Then your inbox appears, and the full mailbox index builds in
   the background. An 80k-message mailbox takes about 30 minutes.

## 6. Optional: turn on AI

Post's AI features (the AI assistant in the sidebar, drafted replies, summaries, AI sections and "waiting on a reply")
use Claude with **your own** Anthropic API key. Create one at <https://console.anthropic.com/settings/keys>, then paste
it when Post offers after sign-in, or later in **Settings → AI**. Most requests cost about a cent, and Post stops at a
monthly cap you set (default $5). The key is stored in Windows Credential Manager.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Access blocked: Post has not completed the Google verification process" | Add yourself as a test user (step 3.4), or check that the app is published. |
| Post asks you to sign in again every week | The app is still in *Testing* mode. Publish it (step 3.4). |
| Contact suggestions only include people you've emailed | The People API isn't enabled (step 2.3). |
| "redirect_uri_mismatch" | The client was created as *Web application*. Create a new **Desktop app** client. |
| Home's calendar says the Calendar API isn't enabled | Enable the **Google Calendar API** (step 2.4), then press **Check again**. |
| Home's calendar asks for permission | Click **Connect calendar** and approve calendar access (or add the scope in step 3.3). |

Your OAuth client secret and refresh token are stored in **Windows Credential Manager** under "Post Mail".
Signing out of Post removes them and clears the local mail cache.
