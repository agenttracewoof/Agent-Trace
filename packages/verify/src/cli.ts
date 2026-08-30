#!/usr/bin/env node
import { MANIFEST_VERSION } from '@agenttrace/manifest'

process.stdout.write(`agenttrace-verify (manifest format v${MANIFEST_VERSION})\n`)
