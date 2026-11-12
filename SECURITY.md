# Security policy

- Never commit `.env`, bot tokens, database credentials, R2 keys, voice model files, or private consent documents.
- Keep the R2 bucket private and scope its access key to the application bucket.
- Use unique random secrets (32+ characters) for `TELEGRAM_WEBHOOK_SECRET` and `AI_WORKER_CALLBACK_SECRET`.
- Restrict Telegram webhook and worker callback routes with their respective secrets.
- Only process audio the user owns or is authorized to use. Only enable preset voices with documented rights-holder permission and consent.
- Report vulnerabilities privately to the repository owner; do not publish exploit details in an issue.
