#!/usr/bin/env bats
#
# POSITIVE CONTROL for require_agentbox_images_not_stale (scripts/_common.sh),
# app#579.
#
# hill90/agentbox and hill90/agentbox-monitor copy the akm CLI out of
# hill90/knowledge at build time. A knowledge deploy does not rebuild them —
# that is a separate, manual `build-agentbox-images.yml` run — and nothing in
# the merge or deploy path signalled that second step was due. It bit twice
# in one day: an image-stamp defect (#558) and, more seriously, a security
# fix (SSRF DNS-rebinding, #573/#545) that was live in knowledge and absent
# from agentbox for a day, caught only by a four-hourly drift alarm.
#
# THE DIRECTION THAT MATTERS, per the issue: prove that a change under
# services/knowledge/ makes deploy.sh's knowledge path either see the
# agentbox images rebuilt, or refuse. Proving the images CAN be read back is
# not the same claim — every test here starts from a REAL git repository
# with a real services/knowledge/ commit landing after the agentbox images'
# stamp, the same fixture discipline deploy-drift-control.bats uses for the
# same reason: the check reads git, so the control gives it git.

setup() {
    ROOT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
    COMMON="$ROOT/scripts/_common.sh"

    REPO="$BATS_TEST_TMPDIR/repo"
    mkdir -p "$REPO"
    cd "$REPO"
    git init -q -b main .
    git config user.email t@example.com
    git config user.name t

    mkdir -p services/knowledge services/agentbox
    echo base > services/knowledge/base.py
    git add services/knowledge/base.py
    git commit -qm "base knowledge"
    AGENTBOX_STAMP="$(git rev-parse HEAD)"

    # A stub docker on PATH. require_agentbox_images_not_stale only ever calls
    # `docker inspect -f '{{index .Config.Labels "com.hill90.revision"}}' <img>:latest`
    # — the stub answers that one shape and nothing else, from a file so each
    # test can set a different label per image without editing the stub.
    STUB="$BATS_TEST_TMPDIR/bin"
    mkdir -p "$STUB"
    LABELS_FILE="$BATS_TEST_TMPDIR/labels.env"
    : > "$LABELS_FILE"
    cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "inspect" ]; then
    img="${*: -1}"
    key="$(printf '%s' "$img" | tr '/:.' '___')"
    val="$(grep -m1 "^${key}=" "$LABELS_FILE" | cut -d= -f2-)"
    if [ -z "$val" ]; then
        echo "<no value>"
        exit 0
    fi
    if [ "$val" = "__MISSING__" ]; then
        exit 1
    fi
    echo "$val"
    exit 0
fi
exit 1
EOF
    chmod +x "$STUB/docker"
    export LABELS_FILE
    export PATH="$STUB:$PATH"

    set_label() {
        local img="$1" rev="$2"
        local key
        key="$(printf '%s' "${img}:latest" | tr '/:.' '___')"
        printf '%s=%s\n' "$key" "$rev" >> "$LABELS_FILE"
    }
}

run_check() {
    bash -c "
        set -uo pipefail
        source '$COMMON' >/dev/null 2>&1
        PROJECT_ROOT='$REPO'
        require_agentbox_images_not_stale '$1'
    "
}

# ------------------------------------------------------------- POSITIVE ---

@test "POSITIVE CONTROL: a services/knowledge/ commit after the agentbox stamp is refused" {
    set_label "hill90/agentbox" "$AGENTBOX_STAMP"
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    echo change > services/knowledge/base.py
    git add services/knowledge/base.py
    git commit -qm "knowledge: the change that must be caught"
    deploy_rev="$(git rev-parse HEAD)"

    run run_check "$deploy_rev"
    [ "$status" -eq 1 ]
    [[ "$output" == *"hill90/agentbox:latest"* ]]
    [[ "$output" == *"1 services/agentbox/ or services/knowledge/ commit(s) behind"* ]]
    [[ "$output" == *"app#579"* ]]
}

@test "TWIN: the same commit, but the agentbox images are stamped AT it, passes" {
    echo change > services/knowledge/base.py
    git add services/knowledge/base.py
    git commit -qm "knowledge: rebuilt into agentbox too"
    deploy_rev="$(git rev-parse HEAD)"

    set_label "hill90/agentbox" "$deploy_rev"
    set_label "hill90/agentbox-monitor" "$deploy_rev"

    run run_check "$deploy_rev"
    [ "$status" -eq 0 ]
}

@test "a services/agentbox/ only commit is caught too — same dep_re as the drift alarm" {
    set_label "hill90/agentbox" "$AGENTBOX_STAMP"
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    echo change > services/agentbox/app.py
    git add services/agentbox/app.py
    git commit -qm "agentbox: touched directly, not via knowledge"
    deploy_rev="$(git rev-parse HEAD)"

    run run_check "$deploy_rev"
    [ "$status" -eq 1 ]
    [[ "$output" == *"behind"* ]]
}

@test "TWIN: a commit that touches neither prefix does not trip it" {
    set_label "hill90/agentbox" "$AGENTBOX_STAMP"
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    echo doc > README.md
    git add README.md
    git commit -qm "docs: unrelated"
    deploy_rev="$(git rev-parse HEAD)"

    run run_check "$deploy_rev"
    [ "$status" -eq 0 ]
}

# ---------------------------------------------------------- ABSENT / BAD ---

@test "a missing image is refused, not silently skipped" {
    set_label "hill90/agentbox" "__MISSING__"
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    run run_check "$AGENTBOX_STAMP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"does not exist"* ]]
}

@test "an image with no com.hill90.revision label is refused, not read as current" {
    # The stub's default (no matching key) already returns <no value>, exactly
    # what `docker inspect -f` prints for an absent label — no explicit set_label call.
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    run run_check "$AGENTBOX_STAMP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"hill90/agentbox:latest"* ]]
    [[ "$output" == *"carries no com.hill90.revision label"* ]]
}

@test "a label naming a commit this repo has never heard of is refused, not assumed current" {
    set_label "hill90/agentbox" "0000000000000000000000000000000000000000"
    set_label "hill90/agentbox-monitor" "$AGENTBOX_STAMP"

    run run_check "$AGENTBOX_STAMP"
    [ "$status" -eq 1 ]
    [[ "$output" == *"not a commit in this repository"* ]]
}
