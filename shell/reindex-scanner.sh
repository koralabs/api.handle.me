#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

TARGET_ALIAS="${1:-mainnet}"
TARGET_ALIAS_UPPER="$(echo "$TARGET_ALIAS" | tr '[:lower:]' '[:upper:]')"

API_KEY="${HANDLES_API_KEY:-}"
if [ -z "${API_KEY}" ]; then
    echo "Missing API key. Set HANDLES_API_KEY in .env."
    exit 1
fi

ROUTE53_HOSTED_ZONE_ID="Z0531656ZQGHBU9QH3QC"

get_route53_set_identifier() {
    local env_key="$1"
    local suffix="${env_key#API_SCANNER_FUNCTION_URL_}"
    local alias_upper="${suffix##*_}"
    local region_token="${suffix%_"${alias_upper}"}"
    local region_name=""
    if [[ "$region_token" == *"EAST"* ]]; then
        region_name="east"
    elif [[ "$region_token" == *"WEST"* ]]; then
        region_name="west"
    else
        echo "Unable to resolve region from ${env_key}"
        return 1
    fi
    local network
    network="$(echo "$alias_upper" | tr '[:upper:]' '[:lower:]')"
    echo "${region_name}-${network}-api"
}

get_route53_record() {
    local set_identifier="$1"
    aws route53 list-resource-record-sets \
        --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" \
        --query "ResourceRecordSets[?SetIdentifier==\`${set_identifier}\`] | [0]" \
        --output json
}

get_route53_weight() {
    local set_identifier="$1"
    local record
    record="$(get_route53_record "$set_identifier")"
    local weight
    weight="$(jq -r '.Weight // empty' <<< "$record")"
    if [ -z "$weight" ]; then
        echo "Route53 record not found for ${set_identifier}"
        return 1
    fi
    echo "$weight"
}

set_route53_weight() {
    local set_identifier="$1"
    local weight="$2"
    local record
    record="$(get_route53_record "$set_identifier")"
    if [ "$record" = "null" ] || [ -z "$record" ]; then
        echo "Route53 record not found for ${set_identifier}"
        return 1
    fi

    local payload
    payload="$(jq -c --argjson weight "$weight" '{Comment:"Adjust route53 weight for scanner reindex",Changes:[{Action:"UPSERT","ResourceRecordSet":(. | .Weight=$weight)}]}' <<< "$record")"

    local status
    status="$(aws route53 change-resource-record-sets --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" --change-batch "$payload")"
    local status_id
    status_id="$(jq -r '.ChangeInfo.Id' <<< "$status")"
    while [ "$(jq -r '.ChangeInfo.Status' <<< "$status")" = "PENDING" ]; do
        sleep 5
        status="$(aws route53 get-change --id "$status_id")"
    done
}

TARGETS=()
for env_key in $(compgen -A variable | sort); do
    if [[ "$env_key" == API_SCANNER_FUNCTION_URL_* ]]; then
        if [ "$TARGET_ALIAS_UPPER" != "ALL" ] && [[ "$env_key" != *"_${TARGET_ALIAS_UPPER}" ]]; then
            continue
        fi
        value="${!env_key:-}"
        if [ -n "$value" ]; then
            TARGETS+=("${env_key}=${value}")
        fi
    fi
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
    echo "No matching API_SCANNER_FUNCTION_URL_* variables found for alias '${TARGET_ALIAS}'."
    exit 1
fi

for item in "${TARGETS[@]}"; do
    env_key="${item%%=*}"
    base_url="${item#*=}"
    endpoint="${base_url%/}/reindex"
    set_identifier="$(get_route53_set_identifier "$env_key")"
    original_weight="$(get_route53_weight "$set_identifier")"
    echo "Setting ${set_identifier} weight to 0"
    set_route53_weight "$set_identifier" 0

    echo "Triggering reindex via ${env_key}"
    set +e
    http_code="$(curl -sS -o /tmp/reindex-scanner-response.txt -w "%{http_code}" \
        -X POST \
        -H "content-type: application/json" \
        -H "api-key: ${API_KEY}" \
        --data '{"reindex":true}' \
        "${endpoint}")"
    curl_exit=$?
    set -e

    echo "Restoring ${set_identifier} weight to ${original_weight}"
    set_route53_weight "$set_identifier" "$original_weight"

    if [ "$curl_exit" -ne 0 ]; then
        echo "Reindex request failed for ${env_key}"
        exit "$curl_exit"
    fi

    echo "HTTP ${http_code}"
    cat /tmp/reindex-scanner-response.txt
    echo
done
