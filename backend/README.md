# YapPay Node backend

This server provides email-or-username/password authentication, optional Google sign-in, and the existing M-Pesa (Safaricom Daraja STK Push) demo. Requires Node >= 20.6.

## Database setup

The `database/` folder contains the PostgreSQL connection layer and `schema.sql` for users, sessions and M-Pesa checkout records. Set `DATABASE_URL` to a PostgreSQL connection string to use Postgres. The backend applies the idempotent schema at startup and stores users and login sessions there. Passwords use salted scrypt hashes; session tokens are hashed before being stored. In local demo mode, when `DATABASE_URL` is unset, accounts use the ignored `data/users.json` file and sessions remain in memory. `NODE_ENV=production` requires `DATABASE_URL`.

The root `render.yaml` Blueprint creates a Render Postgres database and links its internal connection URL to the backend as `DATABASE_URL`. The Blueprint currently uses Render's smallest paid Postgres compute plan; check provider pricing before provisioning. For local development with hosted Postgres, use the provider's external connection URL and its required TLS settings.

## Local login demo

From the website folder, run `npm run backend:install` once and then `npm run backend:start`. Open http://localhost:3000, select **Sign up**, and add an email, username, and password. Users can log in with either their email or username. Usernames are 3–24 letters, numbers or underscores; passwords must contain at least 8 characters. Local demo accounts are stored in `data/users.json` (ignored by Git). Existing users can add an email under **Profile → Edit profile**. Regular signup email addresses are not verified until an email service is configured.

## Google sign-in

Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` on the backend. In Google Cloud Console, add the callback URL `http://localhost:3000/api/auth/google/callback` for local development and the public HTTPS callback URL for production. The backend uses Google's OAuth 2.0 authorization-code flow, validates the state and nonce, verifies the ID token and verified email, then creates or signs into the matching account. Never expose the client secret in frontend code.

On the login screen, **Forgot password?** starts a local demo reset using the username or email. The reset link is shown on screen because no email service is configured. Links expire after 30 minutes, are single-use, and only their SHA-256 hashes are stored. Production mode returns an unavailable response until a trusted email delivery provider is configured; reset tokens are never exposed in production.

## M-Pesa demo

1. Create an app at https://developer.safaricom.co.ke and get the consumer key/secret, shortcode and passkey.
2. Copy `.env.example` to `.env` and fill in the Daraja settings.
3. Expose the server over HTTPS and set `CALLBACK_URL` to `<that-url>/api/mpesa/callback`.
4. Run `npm start`.

Endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`; `POST /api/mpesa/stkpush`, `POST /api/mpesa/callback`, and `GET /api/mpesa/status/:checkoutRequestId`.

M-Pesa payment status is persisted in PostgreSQL. Membership balances are still demo data and are not yet linked to user accounts.

## Android WebView sign-in

The Android APK loads its UI from `https://localhost` and sends account requests to the URL in `Android_App/www/yappay-config.js`. Set `ALLOWED_ORIGIN=https://localhost` on the backend (plus any other exact HTTPS origins, comma-separated). Production session cookies use `Secure; SameSite=None`; the Android WebView is configured to accept that cross-origin cookie. Keep wildcard CORS disabled for credentialed app sign-in.