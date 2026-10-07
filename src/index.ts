import * as core from '@actions/core'
import { execute } from './delivery.ts'

const operation = process.argv[2] ?? core.getInput('operation')
const inputConfig = core.getInput('config')
const config =
  inputConfig.length > 0
    ? inputConfig
    : '.github/config/terraform-delivery.json'
await execute(operation, config, process.argv.slice(3))
