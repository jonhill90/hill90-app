.PHONY: help test test-api test-ui test-python test-scripts lint lint-api lint-ui lint-python lint-selftest check check-links check-shell up down status logs reset deploy

# A single front door for a repository whose real entry points are spread across
# scripts/, two npm packages and four poetry projects. Every target below wraps
# something that already existed; nothing here is a new capability.
#
# Conventions deliberately match the platform repo's Makefile (Hill90), so that
# moving between the two costs nothing: the `## ` help pattern, .PHONY, one
# target per real operation.

# Colors for output
COLOR_RESET = \033[0m
COLOR_BOLD = \033[1m
COLOR_GREEN = \033[32m
COLOR_YELLOW = \033[33m
COLOR_BLUE = \033[36m

# The four poetry projects. `knowledge` is handled separately in test-python
# because CI excludes its integration suite, and this file must not claim to run
# more than CI does.
PY_SERVICES = services/mcp services/agentbox services/ai

# Deploy inputs. DRY_RUN defaults to true on purpose: the repo's own guidance is
# to dry-run first, and a Makefile should not make the dangerous thing the
# default keystroke.
SERVICE ?=
DRY_RUN ?= true

# ============================================================================
# Help & Information
# ============================================================================

help: ## Show this help message
	@echo "$(COLOR_BOLD)hill90-app$(COLOR_RESET)"
	@echo ""
	@echo "$(COLOR_BLUE)Available commands:$(COLOR_RESET)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(COLOR_GREEN)%-18s$(COLOR_RESET) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(COLOR_YELLOW)Deploys are pipeline-only.$(COLOR_RESET) make deploy dispatches the"
	@echo "workflow; it never runs scripts/deploy.sh on a workstation."

# ============================================================================
# Tests — these are exactly what ci.yml runs
# ============================================================================

test: test-api test-ui test-python test-scripts ## Run every suite CI runs

test-api: ## Run the api suite (jest)
	@echo "$(COLOR_BOLD)services/api — jest$(COLOR_RESET)"
	cd services/api && npm test

test-ui: ## Run the ui suite (vitest)
	@echo "$(COLOR_BOLD)services/ui — vitest$(COLOR_RESET)"
	cd services/ui && npm test

test-python: ## Run pytest for all four Python services
	@for s in $(PY_SERVICES); do \
		echo "$(COLOR_BOLD)$$s — pytest$(COLOR_RESET)"; \
		(cd $$s && poetry install --no-interaction --quiet && poetry run pytest) || exit 1; \
	done
	@echo "$(COLOR_BOLD)services/knowledge — pytest (integration excluded, as in CI)$(COLOR_RESET)"
	cd services/knowledge && poetry install --no-interaction --quiet && poetry run pytest --ignore=tests/integration

test-scripts: ## Run the shell test suite (bats)
	@echo "$(COLOR_BOLD)tests/scripts — bats$(COLOR_RESET)"
	bats --recursive tests/scripts/

# ============================================================================
# Lint — each of these already exists as a package script or dev dependency
#
# All three were broken until 2026-07-31 and are now fixed:
#
#   services/api  had NO eslint config of any kind, so `eslint src --ext .ts`
#                 exited saying it could not find one. Added .eslintrc.cjs.
#   services/ui   ran `next lint`, removed in Next 16. Migrated to `eslint .`
#                 with the native flat configs from eslint-config-next, and
#                 pinned eslint to ^9 because eslint-config-next 16 bundles
#                 eslint-plugin-react 7.37, whose peer range stops at ^9.7.
#   python        53 ruff findings across three services, now zero.
#
# ci.yml runs all three in the `lint (api, ui, python)` job, so this is enforced
# rather than remembered. The npm services carry a documented backlog of demoted
# rules -- see the configs for counts and reasons.
# ============================================================================

lint: lint-api lint-ui lint-python ## Lint every service

lint-api: ## Lint the api (eslint)
	cd services/api && npm run lint

lint-ui: ## Lint the ui (next lint)
	cd services/ui && npm run lint

lint-selftest: ## Prove each lint arm can actually FAIL
	bash scripts/checks/lint-selftest.sh

lint-python: ## Lint every Python service (ruff)
	@for s in $(PY_SERVICES) services/knowledge; do \
		echo "$(COLOR_BOLD)$$s — ruff$(COLOR_RESET)"; \
		(cd $$s && poetry install --no-interaction --quiet && poetry run ruff check .) || exit 1; \
	done

# ============================================================================
# Repository checks — the same ones the workflow runs
# ============================================================================

check: check-links check-shell ## Run the repository-level checks

check-links: ## Verify every internal markdown link resolves
	python3 scripts/checks/check_md_links.py

check-shell: ## Parse every shell script (bash -n)
	@for f in scripts/*.sh scripts/checks/*.sh tests/scripts/*.sh; do \
		bash -n "$$f" && echo "ok  $$f"; \
	done

# ============================================================================
# Local stack
# ============================================================================

up: ## Bring the local stack up
	bash scripts/local.sh up

down: ## Stop the local stack
	bash scripts/local.sh down

status: ## Show local stack status
	bash scripts/local.sh status

logs: ## Follow local stack logs
	bash scripts/local.sh logs

reset: ## DESTROY local volumes and state (requires CONFIRM=yes)
	@if [ "$(CONFIRM)" != "yes" ]; then \
		echo "$(COLOR_YELLOW)Refusing:$(COLOR_RESET) this destroys local volumes."; \
		echo "Re-run as: make reset CONFIRM=yes"; \
		exit 1; \
	fi
	bash scripts/local.sh reset

# ============================================================================
# Deploy — pipeline only
# ============================================================================

deploy: ## Dispatch the deploy pipeline (SERVICE=ui [DRY_RUN=false])
	@if [ -z "$(SERVICE)" ]; then \
		echo "$(COLOR_YELLOW)SERVICE is required.$(COLOR_RESET)"; \
		echo "  make deploy SERVICE=ui                # dry run (default)"; \
		echo "  make deploy SERVICE=ui DRY_RUN=false  # real deploy"; \
		echo ""; \
		echo "Valid services: api ai knowledge mcp minio ui"; \
		echo "db and auth are RETIRED and deploy.sh refuses them."; \
		exit 1; \
	fi
	gh workflow run "Manual Deploy App (Prod)" -f service=$(SERVICE) -f dry_run=$(DRY_RUN)
