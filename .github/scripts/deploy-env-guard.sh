#!/usr/bin/env bash
set -eu

EVENT_NAME=${1:?usage: deploy-env-guard.sh <event> <ref> <selected>}
REF_NAME=${2:?usage: deploy-env-guard.sh <event> <ref> <selected>}
SELECTED_ENV=${3-}

if [ "$SELECTED_ENV" = auto ] || [ -z "$SELECTED_ENV" ]; then
  RESOLVED_ENV=$REF_NAME
else
  RESOLVED_ENV=$SELECTED_ENV
fi

if [ "$EVENT_NAME" = workflow_dispatch ]; then
  case "$REF_NAME" in
    preview|preprod|mainnet)
      if [ "$RESOLVED_ENV" != "$REF_NAME" ]; then
        echo "::error::Dispatch environment '$RESOLVED_ENV' does not match branch '$REF_NAME'. Choose '$REF_NAME' or auto." >&2
        exit 1
      fi
      ;;
    *)
      if [ "$SELECTED_ENV" = auto ] || [ -z "$SELECTED_ENV" ]; then
        echo "::error::Branch '$REF_NAME' is not an environment branch; choose an explicit deployment environment." >&2
        exit 1
      fi
      ;;
  esac
fi

printf '%s\n' "$RESOLVED_ENV"
