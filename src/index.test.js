'use strict';

const request = require('supertest');

process.env.APP_NAME = 'test-app';
process.env.APP_ENV = 'test';
process.env.IMAGE_TAG = 'sha-test';

const { app, server } = require('./index');

afterAll(() => server.close());

describe('GET /health', () => {
  it('returns 200 OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });
});

describe('GET /whois', () => {
  it('returns app metadata as JSON', async () => {
    const res = await request(app).get('/whois');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app_name: 'test-app',
      environment: 'test',
      image_tag: 'sha-test',
    });
  });
});

describe('GET /', () => {
  it('returns HTML containing app name and env', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('test-app');
    expect(res.text).toContain('sha-test');
  });
});
