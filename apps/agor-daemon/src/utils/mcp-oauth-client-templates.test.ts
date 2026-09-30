import type { MCPAuth } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  hasMCPOAuthClientTemplates,
  MCPOAuthClientTemplateError,
  resolveMCPOAuthClientTemplates,
} from './mcp-oauth-client-templates.js';

const templatedAuth: MCPAuth = {
  type: 'oauth',
  oauth_mode: 'per_user',
  oauth_client_id: '{{ user.env.GOOGLE_FUCHSTRAVELS_CLIENT_ID }}',
  oauth_client_secret: '{{ user.env.GOOGLE_FUCHSTRAVELS_CLIENT_SECRET }}',
  oauth_scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

function captureError(work: () => unknown): MCPOAuthClientTemplateError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(MCPOAuthClientTemplateError);
    return error as MCPOAuthClientTemplateError;
  }
  throw new Error('expected MCPOAuthClientTemplateError');
}

describe('resolveMCPOAuthClientTemplates', () => {
  it('renders templated client fields and leaves everything else untouched', () => {
    const resolved = resolveMCPOAuthClientTemplates(templatedAuth, {
      GOOGLE_FUCHSTRAVELS_CLIENT_ID: 'client-123.apps.googleusercontent.com',
      GOOGLE_FUCHSTRAVELS_CLIENT_SECRET: 'rendered-secret',
      UNRELATED: 'ignored',
    });
    expect(resolved).toEqual({
      ...templatedAuth,
      oauth_client_id: 'client-123.apps.googleusercontent.com',
      oauth_client_secret: 'rendered-secret',
    });
    // The input row is not mutated; callers keep the templated authority.
    expect(templatedAuth.oauth_client_id).toBe('{{ user.env.GOOGLE_FUCHSTRAVELS_CLIENT_ID }}');
  });

  it('returns the same object when no OAuth client field is templated', () => {
    const plain: MCPAuth = { type: 'oauth', oauth_client_id: 'literal-client' };
    expect(hasMCPOAuthClientTemplates(plain)).toBe(false);
    expect(resolveMCPOAuthClientTemplates(plain, {})).toBe(plain);
  });

  it('renders templated endpoint overrides', () => {
    const resolved = resolveMCPOAuthClientTemplates(
      {
        type: 'oauth',
        oauth_client_id: 'literal-client',
        oauth_token_url: 'https://{{ user.env.IDP_HOST }}/token',
      },
      { IDP_HOST: 'idp.example.test' }
    );
    expect(resolved.oauth_token_url).toBe('https://idp.example.test/token');
  });

  it('names every missing variable and never includes a value', () => {
    const error = captureError(() =>
      resolveMCPOAuthClientTemplates(templatedAuth, {
        GOOGLE_FUCHSTRAVELS_CLIENT_SECRET: '',
        OTHER_SECRET: 'must-not-appear',
      })
    );
    expect(error.missingVars).toEqual([
      'GOOGLE_FUCHSTRAVELS_CLIENT_ID',
      'GOOGLE_FUCHSTRAVELS_CLIENT_SECRET',
    ]);
    expect(error.message).toContain('GOOGLE_FUCHSTRAVELS_CLIENT_ID');
    expect(error.message).toContain('GOOGLE_FUCHSTRAVELS_CLIENT_SECRET');
    expect(error.message).toContain('Settings → Environment Variables');
    expect(error.message).not.toContain('must-not-appear');
    expect(error.message).not.toContain('{{');
  });

  it('reports only the variable that is actually missing', () => {
    const error = captureError(() =>
      resolveMCPOAuthClientTemplates(templatedAuth, {
        GOOGLE_FUCHSTRAVELS_CLIENT_SECRET: 'present-secret',
      })
    );
    expect(error.missingVars).toEqual(['GOOGLE_FUCHSTRAVELS_CLIENT_ID']);
    expect(error.unresolvedFields).toEqual(['auth.oauth_client_id']);
    expect(error.message).not.toContain('present-secret');
  });

  it('rejects a templated endpoint that renders to an unsafe URL', () => {
    const error = captureError(() =>
      resolveMCPOAuthClientTemplates(
        {
          type: 'oauth',
          oauth_client_id: 'literal-client',
          oauth_authorization_url: '{{ user.env.AUTH_URL }}',
        },
        { AUTH_URL: 'javascript:alert(1)' }
      )
    );
    expect(error.missingVars).toEqual([]);
    expect(error.unresolvedFields).toEqual(['auth.oauth_authorization_url']);
    expect(error.message).not.toContain('javascript');
  });
});
