// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

/**
 * macOS 签名凭据的可选降级契约。
 *
 * fork 或没有 Apple 开发者账号的仓库拿不到 APPLE_* secrets（GitHub 不会把 secrets
 * 继承到 fork），此前 build-macos.yml 与 build-bundle-macos.yml 的硬校验会让两个
 * macOS job 直接失败，连带 finalize 永不发布。这里锁四件事：
 *   1. 五项齐全 → signed=true，并把凭据写进 GITHUB_ENV；
 *   2. 五项全缺 → signed=false 且**不**写 GITHUB_ENV（tauri 用 `var_os()` 判断变量
 *      是否存在，空的 APPLE_CERTIFICATE 会被当成已提供证书去导入而失败）；
 *   3. 只配了一部分 → 明确失败，避免拼错的配置静默产出未签名包；
 *   4. 构建步骤不再直接注入 APPLE_*，签名校验只在 signed=true 时执行。
 */

const WORKFLOWS = [
  '.github/workflows/build-macos.yml',
  '.github/workflows/build-bundle-macos.yml',
] as const

const APPLE_SECRETS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
] as const

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function detectStepBody(workflow: string): string {
  const source = readSource(workflow)
  const body = source.match(/ {6}- name: Detect signing credentials\n([\s\S]*?)(?=\n {6}- |$)/)?.[1]
  expect(body, workflow).toBeTypeOf('string')
  const script = body?.match(/ {8}run: \|\n([\s\S]*)$/)?.[1]
  expect(script, workflow).toBeTypeOf('string')
  return script!.replace(/^ {10}/gm, '')
}

function runDetect(workflow: string, credentials: Partial<Record<(typeof APPLE_SECRETS)[number], string>>) {
  const dir = mkdtempSync(join(tmpdir(), 'macos-signing-'))
  tempDirs.push(dir)
  const outputFile = join(dir, 'output')
  const envFile = join(dir, 'env')
  writeFileSync(outputFile, '')
  writeFileSync(envFile, '')

  // 只传入本次用例需要的变量：未提供的项在子进程里完全不存在，等价于 secret 未配置。
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GITHUB_OUTPUT: outputFile,
    GITHUB_ENV: envFile,
  }
  for (const [name, value] of Object.entries(credentials))
    env[name] = value!

  const result = spawnSync('bash', ['-c', detectStepBody(workflow)], { env, encoding: 'utf8', timeout: 10000 })
  expect(result.error).toBeUndefined()
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: readFileSync(outputFile, 'utf8'),
    env: readFileSync(envFile, 'utf8'),
  }
}

const complete = Object.fromEntries(APPLE_SECRETS.map(name => [name, `value-of-${name}`]))

describe('macOS signing credential fallback', () => {
  it.each(WORKFLOWS)('%s declares every Apple secret as optional', (workflow) => {
    const source = readSource(workflow)
    for (const name of APPLE_SECRETS) {
      expect(source, `${workflow} ${name}`).toMatch(new RegExp(` {6}${name}:\\n {8}required: false`))
    }
  })

  it.each(WORKFLOWS)('%s builds unsigned when no credentials are configured', (workflow) => {
    const result = runDetect(workflow, {})
    expect(result.status).toBe(0)
    expect(result.output).toContain('signed=false')
    expect(result.env).toBe('')
    expect(result.stdout).toContain('unsigned')
  })

  it.each(WORKFLOWS)('%s signs and exports credentials when all five are configured', (workflow) => {
    const result = runDetect(workflow, complete)
    expect(result.status).toBe(0)
    expect(result.output).toContain('signed=true')
    for (const name of APPLE_SECRETS)
      expect(result.env).toContain(`${name}=value-of-${name}`)
  })

  it.each(WORKFLOWS)('%s rejects partially configured credentials', (workflow) => {
    const { APPLE_TEAM_ID: _omitted, ...partial } = complete
    const result = runDetect(workflow, partial)
    expect(result.status).toBe(1)
    // GitHub 的 workflow command（`::error::`）写在 stdout 上。
    expect(result.stdout).toContain('Incomplete macOS signing credentials')
    expect(result.stdout).toContain('APPLE_TEAM_ID')
    expect(result.env).toBe('')
  })

  it.each(WORKFLOWS)('%s keeps signing checks behind the detected flag', (workflow) => {
    const source = readSource(workflow)
    const build = source.match(/ {6}- name: (?:Build package|Build offline package)\n([\s\S]*?)(?=\n {6}- |$)/)?.[1]
    expect(build, workflow).toBeTypeOf('string')
    // 空字符串会被 tauri 当成「已提供证书」，所以构建步骤不能再直接注入 APPLE_*。
    expect(build, workflow).not.toContain('APPLE_')
    expect(source, workflow).toContain(
      'if: steps.check.outputs.should_run == \'true\' && steps.signing.outputs.signed == \'true\'',
    )
    expect(source, workflow).toContain(
      'if: steps.check.outputs.should_run == \'true\' && steps.signing.outputs.signed != \'true\'',
    )
  })
})
