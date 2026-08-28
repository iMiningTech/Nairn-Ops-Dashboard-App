#!/usr/bin/env bash
# Build the dashboard, ensure the hosting stack exists, sync the static export to
# S3, and invalidate CloudFront. Re-run any time to publish changes.
#
#   AWS_PROFILE=imining-dev ./hosting/deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Production dashboard lives in account 432046692351 → profile `imining-prod`.
# (Note: the account naming was flipped for compliance — `imining-dev` now points
# at a different account, so do NOT use it for this deploy.)
PROFILE="${AWS_PROFILE:-imining-prod}"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-nairn-dashboard-prod}"

echo "1/4  Building web (static export → web/out)…"
( cd "$HERE/../web" && npm run build )

echo "2/4  Ensuring hosting stack '$STACK'… (first run creates CloudFront — ~10 min)"
aws cloudformation deploy \
  --template-file "$HERE/template.yaml" \
  --stack-name "$STACK" \
  --parameter-overrides Environment=prod \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" --profile "$PROFILE"

get() { aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" --profile "$PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET="$(get BucketName)"; DIST="$(get DistributionId)"; URL="$(get Url)"

echo "3/4  Syncing web/out → s3://$BUCKET …"
# Content-hashed assets (JS/CSS/images) never change under a given name → cache forever.
aws s3 sync "$HERE/../web/out" "s3://$BUCKET" --delete --region "$REGION" --profile "$PROFILE" \
  --exclude "*.html" --exclude "*.txt" --cache-control "public, max-age=31536000, immutable"
# HTML + Next route text MUST revalidate every load, or browsers serve a stale
# app and never pick up new deploys. no-cache = always check with the origin.
aws s3 sync "$HERE/../web/out" "s3://$BUCKET" --region "$REGION" --profile "$PROFILE" \
  --exclude "*" --include "*.html" --include "*.txt" --cache-control "no-cache, must-revalidate"

echo "4/4  Invalidating CloudFront ($DIST)…"
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --region "$REGION" --profile "$PROFILE" >/dev/null

echo ""
echo "Done ✔  Dashboard live at: $URL"
echo "(First deploy: CloudFront can take ~10–15 min to finish provisioning.)"
