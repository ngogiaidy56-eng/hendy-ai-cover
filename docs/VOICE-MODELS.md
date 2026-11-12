# Configure a licensed preset voice

Hendy AI Cover does not bundle or download a person's voice model automatically. The operator must obtain the model from its rights holder or train/commission it with explicit consent, and must check whether the license allows the intended deployment and use.

## 1. Prepare the model

You need an RVC `.pth` model. An `.index` file is optional. Use a model compatible with the RVC project's offline CLI. Do not use an unknown model just because it can be downloaded publicly.

Keep the original license, consent, owner details, and model provenance in your private operational records. Do not put that paperwork or model files in this public source repository unless the rights holder expressly authorizes it.

## 2. Upload to private R2

Create an R2 bucket (default name `hendy-ai-cover`) and an S3-compatible API token restricted to that bucket. Using AWS CLI:

```bash
aws s3 cp ./authorized-voice.pth s3://hendy-ai-cover/models/voices/authorized-voice.pth \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com

# Optional retrieval index:
aws s3 cp ./authorized-voice.index s3://hendy-ai-cover/models/voices/authorized-voice.index \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Do not enable public bucket access. The API and worker access R2 with credentials stored as environment variables.

## 3. Add an entry to config/voices.json

Use `config/voices.example.json` as a template. Example:

```json
{
  "version": 1,
  "voices": [
    {
      "id": "licensed-voice-001",
      "name": "Preset Voice 01",
      "description": "Voice model licensed by its rights holder.",
      "enabled": true,
      "model_key": "models/voices/authorized-voice.pth",
      "index_key": "models/voices/authorized-voice.index",
      "speaker_id": 0,
      "pitch": 0,
      "index_rate": 0.65,
      "f0_method": "rmvpe",
      "rights": {
        "rights_holder": "Name of model/voice rights holder",
        "license": "License name and permitted scope",
        "authorization_reference": "Contract/reference held by the operator",
        "voice_owner_consent": true,
        "commercial_use_allowed": false
      }
    }
  ]
}
```

`voice_owner_consent` must only be true when the operator has actually obtained the relevant permission. `commercial_use_allowed` is a record for the operator; it does not bypass the model license or local law. Pitch is limited to -12..12 semitones; `index_rate` must be between 0 and 1. `index_key` may be omitted; without an index, inference uses `index_rate=0`.

Commit the catalog entry and redeploy both API and worker. The worker checks the R2 model/index object every 10 minutes. A preset is shown to users only after it is marked available by that check.

## 4. Verify

1. Check `GET /health` and `GET /api/voices`.
2. Confirm the preset appears in `/api/voices`.
3. In Telegram, run `/cover`, accept the terms, choose the preset, then send a short audio file you own or are authorized to process.
4. Confirm the job reaches `completed`, the resulting MP3 is sent back, and no model/license information leaks in the user-facing message.

If the model or index cannot be read from R2, the preset is hidden until the worker's next successful check. Check worker logs for `R2 model/index object missing or not accessible` without exposing R2 credentials.
