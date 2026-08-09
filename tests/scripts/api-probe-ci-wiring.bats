#!/usr/bin/env bats

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CI="$ROOT/.github/workflows/ci.yml"
}

@test "api CI enables the 400 and Jest-timeout probes and uploads their workspace artifacts" {
  run python3 - "$CI" <<'PY'
from pathlib import Path
import re
import sys

workflow = Path(sys.argv[1]).read_text()
api = re.search(r'^  api:\n(?P<body>.*?)(?=^  [A-Za-z0-9_-]+:|\Z)', workflow, re.M | re.S)
assert api, 'missing api job'
body = api.group('body')
assert re.search(r'^      PROBE_400: [\'\"]1[\'\"]$', body, re.M)
assert re.search(r'^      PROBE_TIMEOUT: [\'\"]1[\'\"]$', body, re.M)
upload = re.search(
    r'^      - name: Collect flake evidence \(#350\)\n'
    r'        if: always\(\)\n'
    r'        uses: actions/upload-artifact@v4\n'
    r'        with:\n(?P<with>(?:          .*\n)+)',
    body,
    re.M,
)
assert upload, 'api artifact step must use always() and upload-artifact together'
assert re.search(r'^          path: services/api/test-artifacts/$', upload.group('with'), re.M)
PY

  [ "$status" -eq 0 ]
}
