.PHONY: help install build check test mcp start docker clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

build: ## Compile TypeScript to dist/
	npm run build

check: ## Typecheck
	npx tsc --noEmit

test: check ## Typecheck and run the offline test suites
	npm test

mcp: build ## Run the MCP server over stdio
	node dist/ai/mcp.js

start: build ## Run the HTTP API (also serves MCP at POST /mcp)
	npm start

docker: ## Build and start with docker compose
	docker compose up --build

clean: ## Remove build output
	rm -rf dist
