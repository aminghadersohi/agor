import { describe, expect, it } from 'vitest';
import { parseLaunchJsonDocument } from './launch-json';

describe('parseLaunchJsonDocument', () => {
  it('compiles VS Code-shaped profiles into supervised environment variants', () => {
    const environment = parseLaunchJsonDocument(
      {
        version: '0.2.0',
        configurations: [
          {
            name: 'Web dev',
            type: 'node-terminal',
            request: 'launch',
            command: 'pnpm dev',
            cwd: `$${'{workspaceFolder}'}/apps/web`,
            env: { PORT: '{{add 5000 branch.unique_id}}' },
            agor: {
              default: true,
              health: 'http://localhost:{{add 5000 branch.unique_id}}/health',
              app: 'http://localhost:{{add 5000 branch.unique_id}}',
            },
          },
        ],
      },
      '.agor/launch.json'
    );

    expect(environment.default).toBe('Web dev');
    expect(environment.variants['Web dev']).toMatchObject({
      health: 'http://localhost:{{add 5000 branch.unique_id}}/health',
      app: 'http://localhost:{{add 5000 branch.unique_id}}',
    });
    expect(environment.variants['Web dev']!.start).toContain('nohup sh -c');
    expect(environment.variants['Web dev']!.start).toContain('PORT=');
    expect(environment.variants['Web dev']!.start).toContain('{{add 5000 branch.unique_id}}');
    expect(environment.variants['Web dev']!.start).toContain('./apps/web');
    expect(environment.variants['Web dev']!.stop).toContain('kill');
    expect(environment.variants['Web dev']!.logs).toContain('tail -n 100');
  });

  it('supports runtimeExecutable, runtimeArgs, program, and args', () => {
    const environment = parseLaunchJsonDocument(
      {
        configurations: [
          {
            name: 'API',
            type: 'pwa-node',
            request: 'launch',
            runtimeExecutable: 'node',
            runtimeArgs: ['--enable-source-maps'],
            program: `$${'{workspaceFolder}'}/server.js`,
            args: ['--port', '3000'],
          },
        ],
      },
      '.vscode/launch.json'
    );
    expect(environment.variants.API!.start).toContain('node');
    expect(environment.variants.API!.start).toContain('--enable-source-maps');
    expect(environment.variants.API!.start).toContain('./server.js');
  });

  it('rejects attach profiles, duplicate names, and multiple defaults', () => {
    expect(() =>
      parseLaunchJsonDocument(
        { configurations: [{ name: 'Attach', request: 'attach', command: 'node server.js' }] },
        '.vscode/launch.json'
      )
    ).toThrow(/only "launch" is supported/);

    expect(() =>
      parseLaunchJsonDocument(
        {
          configurations: [
            { name: 'Dev', command: 'a' },
            { name: 'Dev', command: 'b' },
          ],
        },
        '.agor/launch.json'
      )
    ).toThrow(/Duplicate/);

    expect(() =>
      parseLaunchJsonDocument(
        {
          configurations: [
            { name: 'A', command: 'a', agor: { default: true } },
            { name: 'B', command: 'b', agor: { default: true } },
          ],
        },
        '.agor/launch.json'
      )
    ).toThrow(/Only one/);
  });

  it('fails clearly for editor orchestration that would otherwise be ignored', () => {
    expect(() =>
      parseLaunchJsonDocument(
        {
          configurations: [{ name: 'Dev', command: 'npm start', preLaunchTask: 'build' }],
        },
        '.vscode/launch.json'
      )
    ).toThrow(/preLaunchTask/);
    expect(() =>
      parseLaunchJsonDocument(
        {
          configurations: [{ name: 'Dev', runtimeExecutable: `$${'{command:pickProcess}'}` }],
        },
        '.vscode/launch.json'
      )
    ).toThrow(/Unsupported launch variable/);
  });
});
