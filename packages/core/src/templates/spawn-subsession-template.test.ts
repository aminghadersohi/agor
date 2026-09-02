import { describe, expect, it } from 'vitest';
import { renderSpawnSubsessionPrompt } from './spawn-subsession-template';

describe('renderSpawnSubsessionPrompt', () => {
  it('substitutes the user prompt verbatim', () => {
    const out = renderSpawnSubsessionPrompt({ userPrompt: 'add tests' });
    expect(out).toContain('"""');
    expect(out).toContain('add tests');
  });

  it('renders the child permissionMode into the meta-prompt', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'do thing',
      permissionMode: 'plan',
    });
    // The template includes "Permission Mode: <value>" for the child.
    expect(out).toContain('Permission Mode:');
    expect(out).toContain('plan');
  });

  it('autocomputes hasConfig when any config field is present', () => {
    const withConfig = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      agenticTool: 'codex',
    });
    expect(withConfig).toContain('USER CONFIGURATION:');

    const noConfig = renderSpawnSubsessionPrompt({ userPrompt: 'x' });
    expect(noConfig).not.toContain('USER CONFIGURATION:');
  });

  it('autocomputes hasCallbackConfig from callbackConfig fields', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      callbackConfig: { enableCallback: true, includeLastMessage: true },
    });
    expect(out).toContain('Callback Configuration:');
  });

  it('carries callbackDelivery into the exact MCP spawn call', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      callbackConfig: { enableCallback: true, callbackDelivery: 'auto' },
    });
    expect(out).toContain('- callbackDelivery: "auto"');
    expect(out).toContain('"callbackDelivery":');
    expect(out.match(/"callbackDelivery"/g)).toHaveLength(1);
  });

  it('renders mcpServerIds with @last separator handling', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      mcpServerIds: ['a', 'b', 'c'],
    });
    // Final list form should not have a trailing comma after the last item.
    expect(out).toMatch(/"a",\s*"b",\s*"c"\s*\]/);
  });

  it('renders the child cleanup policy into the exact MCP call', () => {
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      autoArchive: 'after_completion',
      autoArchiveAfterSeconds: 1800,
    });
    expect(out).toContain('"autoArchive": "after_completion"');
    expect(out).toContain('"autoArchiveAfterSeconds": 1800');
  });

  it('does NOT leak parentPermissionMode into the rendered output even if passed', () => {
    // Defence-in-depth pin for the parent-vs-child permissionMode bug:
    // `parentPermissionMode` is not a template variable; if a caller
    // accidentally passes it, the template should not surface it.
    const out = renderSpawnSubsessionPrompt({
      userPrompt: 'x',
      parentPermissionMode: 'bypassPermissions',
    } as any);
    expect(out).not.toContain('bypassPermissions');
  });
});
