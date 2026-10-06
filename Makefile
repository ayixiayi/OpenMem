PKG := packages/openmemory-js

.PHONY: help install build check test mcp start docker clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

install: ## Install dependencies
	cd $(PKG) && npm ci

build: ## Compile TypeScript to dist/
	cd $(PKG) && npm run build

check: ## Typecheck
	cd $(PKG) && npx tsc --noEmit

test: check ## Typecheck and run the offline test suites
	cd $(PKG) && npm test

mcp: build ## Run the MCP server over stdio
	node $(PKG)/dist/ai/mcp.js

start: build ## Run the HTTP API (also serves MCP at POST /mcp)
	cd $(PKG) && npm start

docker: ## Build and start with docker compose
	docker compose up --build

clean: ## Remove build output
	rm -rf $(PKG)/dist
