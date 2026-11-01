import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { setup, teardown } from './setup.js';
import { seedDatabase } from '../utils/seeder.js';

let adminToken = '';

beforeAll(async () => {
  await setup();
  await seedDatabase();
  const login = await request(app).post('/api/v1/auth/login').send({
    email: 'admin@grandregal.com',
    password: 'HotelPassword123!'
  });
  adminToken = login.body.data.accessToken;
});

afterAll(async () => {
  await teardown();
});

describe('POST /api/v1/guests document requirements', () => {
  const guestDetails = {
    name: 'Document Test Guest',
    phone: '+1 - 5551234567',
    email: 'document.test@example.com'
  };

  it('requires a document type and number', async () => {
    for (const payload of [
      guestDetails,
      { ...guestDetails, idDocumentType: 'passport' },
      { ...guestDetails, idDocumentNumber: 'P1234567' },
      { ...guestDetails, idDocumentType: 'none', idDocumentNumber: 'P1234567' },
      { ...guestDetails, idDocumentType: 'passport', idDocumentNumber: '   ' }
    ]) {
      const response = await request(app)
        .post('/api/v1/guests')
        .set('Authorization', ['Bearer', adminToken].join(' '))
        .send(payload);
      expect(response.status).toBe(400);
    }
  });

  it('creates a guest with a valid document type and number', async () => {
    const response = await request(app)
      .post('/api/v1/guests')
      .set('Authorization', ['Bearer', adminToken].join(' '))
      .send({
        ...guestDetails,
        idDocumentType: 'passport',
        idDocumentNumber: 'P1234567'
      });

    expect(response.status).toBe(201);
    expect(response.body.data.idDocumentType).toBe('passport');
    expect(response.body.data.idDocumentNumber).toBe('P1234567');
  });
});
