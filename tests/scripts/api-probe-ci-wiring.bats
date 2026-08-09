#!/usr/bin/env bats

setup() {
  ROOT="$BATS_TEST_DIRNAME/../.."
  CI="$ROOT/.github/workflows/ci.yml"
}

@test "api CI pins both probes to an always-uploaded API artifact step" {
  run python3 - "$CI" <<'PY'
from pathlib import Path
import re
import sys

def validate(workflow):
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

workflow = Path(sys.argv[1]).read_text()
validate(workflow)

# The current workflow alone could pass a weak grep. Mutate each invariant in
# memory and require the same checker to reject it, without creating a file.
mutations = {
    'PROBE_400 disabled': ("PROBE_400: '1'", "PROBE_400: '0'"),
    'PROBE_TIMEOUT disabled': ("PROBE_TIMEOUT: '1'", "PROBE_TIMEOUT: '0'"),
    'artifact lacks always': (
        '      - name: Collect flake evidence (#350)\n        if: always()\n',
        '      - name: Collect flake evidence (#350)\n',
    ),
    'artifact action replaced': ('uses: actions/upload-artifact@v4', 'uses: actions/download-artifact@v4'),
    'artifact path replaced': ('path: services/api/test-artifacts/', 'path: services/ui/test-artifacts/'),
}
for name, (old, new) in mutations.items():
    mutated = workflow.replace(old, new, 1)
    assert mutated != workflow, f'{name}: mutation target absent'
    try:
        validate(mutated)
    except AssertionError:
        continue
    raise AssertionError(f'{name}: checker accepted mutation')
PY

  [ "$status" -eq 0 ]
}
