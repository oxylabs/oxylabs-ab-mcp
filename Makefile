SHELL := /bin/bash

# Registers this checkout as the "hb" MCP server in Claude Code for all projects (user scope).
#
#   make link OXY_AB_USERNAME=<user> OXY_AB_PASSWORD=<password> [HB_DEFAULT_PARAMS=p_cc=US]
#   make unlink
#
# Credentials are taken from OXY_AB_USERNAME / OXY_AB_PASSWORD in the environment when not given.

NAME  ?= hb
SCOPE ?= user
CLI   := $(abspath dist/cli.js)

OXY_AB_USERNAME ?=
OXY_AB_PASSWORD ?=
HB_DEFAULT_PARAMS ?=

ENV_FLAGS := -e OXY_AB_USERNAME=$(OXY_AB_USERNAME) -e OXY_AB_PASSWORD=$(OXY_AB_PASSWORD)
ifneq ($(strip $(HB_DEFAULT_PARAMS)),)
ENV_FLAGS += -e HB_DEFAULT_PARAMS=$(HB_DEFAULT_PARAMS)
endif

.PHONY: build test link unlink status

build: node_modules
	npm run build

node_modules: package.json package-lock.json
	npm install --no-fund --no-audit
	@touch node_modules

test: node_modules
	npm test

link: build
	@if [ -z "$(OXY_AB_USERNAME)" ] || [ -z "$(OXY_AB_PASSWORD)" ]; then \
		echo "OXY_AB_USERNAME and OXY_AB_PASSWORD are required, e.g. make link OXY_AB_USERNAME=<user> OXY_AB_PASSWORD=<password>"; exit 1; fi
	-@claude mcp remove -s $(SCOPE) $(NAME) >/dev/null 2>&1
	claude mcp add -s $(SCOPE) $(NAME) $(ENV_FLAGS) -- node $(CLI)
	@echo "Registered '$(NAME)' at $(SCOPE) scope -> $(CLI). Restart Claude Code sessions or run /mcp to pick it up."

unlink:
	claude mcp remove -s $(SCOPE) $(NAME)

status:
	@claude mcp get $(NAME) 2>/dev/null || echo "'$(NAME)' is not registered"
