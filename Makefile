# rollhook-action — repo contract (dotfiles/docs/agent-platform.md §Repo contract).
#
# A GitHub Action, so there is no runtime of its own: `check` wraps the same
# validation CI runs (package.json scripts plus committed-bundle freshness) and
# the other targets exist so agents get the truth instead of a missing-target
# error. Thin wrappers only — no new behaviour lives here.

.DEFAULT_GOAL := help

.PHONY: help check deploy verify logs

help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

check: ## Install, typecheck, test, build, and verify committed dist/ is up to date
	npm ci
	npm run typecheck
	npm test
	npm run build
	@git diff --exit-code -- dist/ || { \
		echo "dist/ is stale — run 'npm run build' and commit the result."; \
		exit 1; \
	}

deploy: ## No runtime — CI releases (semantic-release) on every push to main
	@echo "deployed by CI on push: semantic-release cuts the release and moves the floating major tag; nothing to run here"

verify: ## No runtime to probe — the self-test is the CI workflow
	@echo "verify: no runtime to probe - a GitHub Action has no endpoint; the self-test is .github/workflows/ci.yml"

logs: ## No runtime logs — see GitHub Actions run history
	@echo "logs: no runtime logs - see the GitHub Actions run history of this repo"
