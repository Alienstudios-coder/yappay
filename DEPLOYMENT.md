# YapPay deployment preparation

## Hosting layout

- Netlify serves the existing `index.html` and routes `/api/*` through `netlify/functions/api.mjs`.
- Render runs the existing Node API and provisions the PostgreSQL database declared in `render.yaml`.
- The Netlify function forwards API traffic and HttpOnly cookies to Render. This keeps browser login requests same-origin.

## Connect and deploy

1. Initialize/connect this Git repository to a private GitHub repository. The local account store and `.env` files are excluded from Git.
2. Import the repository into Netlify. It reads `netlify.toml`; set the Netlify environment variable `YAPPAY_BACKEND_URL` to the Render backend base URL, with no trailing path, for example `https://your-render-service.onrender.com`.
3. Deploy the Render Blueprint from the same repository using `render.yaml`. Render creates the web service and a temporary free Postgres database. Free Render Postgres expires 30 days after creation; data is inaccessible after expiry and deleted after the 14-day grace period unless upgraded. Do not treat this as long-term storage. Set `ALLOWED_ORIGIN` to the exact Netlify site origin, such as `https://your-site.netlify.app` (no trailing slash).
4. Add real M-Pesa values to Render's environment panel if payments are required. Never put these values in Git, this folder's `.env.example`, Netlify, or chat.
5. For Google sign-in, create an OAuth Web client and add `https://your-site.netlify.app/api/auth/google/callback` as an authorized redirect URI. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the same callback in Render. Keep the client secret only in Render's private environment settings.
6. Wait until both the Render API and Netlify site are healthy. Then test the API and account sign-in through the Netlify URL.

Netlify and Render accounts must be authenticated by the owner. This folder cannot contain working provider credentials; they are issued by those providers and should be entered in their secure environment settings. The `.env.example` file is only a placeholder reference.

## Keep existing accounts

Local accounts are in the ignored file `backend/data/users.json`, which is not uploaded to Git. The passwords are already scrypt-hashed. Once Render PostgreSQL is provisioned and its `DATABASE_URL` is available, copy it to `backend/.env` (which is ignored) and run `npm run db:import-local-users --prefix backend` from this project folder. The importer transfers account IDs and password hashes inside a database transaction; it never exports or prints passwords. Back up the local account file before migration. Do not delete it until hosted login has been verified.

Existing local sessions are not migrated and users will need to sign in again after the move. If you already have a hosted database with accounts, point the backend to that same database and do not provision a replacement. If you are starting with a new hosted database, it starts empty until the importer is run.

## Local check

From this folder, run `npm run backend:start` and open `http://localhost:3000`. Netlify's function proxy requires Netlify's local dev server and `YAPPAY_BACKEND_URL`; it is not used by the direct local backend server.