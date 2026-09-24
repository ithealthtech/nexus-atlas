import { z } from 'zod';
import {
  assetSchema,
  contactSchema,
  createClientSchema,
  createDocumentSchema,
  createPasswordSchema,
  locationSchema,
  relationSchema,
  revealSchema,
  updateAssetSchema,
  updateClientSchema,
  updateDocumentSchema,
  updatePasswordSchema,
} from '@atlas/shared';

type Op = {
  summary: string;
  scope: 'read' | 'write' | 'passwords';
  body?: z.ZodType;
  query?: Record<string, string>;
  created?: boolean;
};

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
const idParam = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });

const PATHS: Record<string, Partial<Record<'get' | 'post' | 'patch' | 'delete', Op>>> = {
  '/clients': {
    get: { summary: 'List clients you can access', scope: 'read' },
    post: { summary: 'Create a client', scope: 'write', body: createClientSchema, created: true },
  },
  '/clients/{id}': {
    get: { summary: 'Get a client', scope: 'read' },
    patch: { summary: 'Update a client', scope: 'write', body: updateClientSchema },
  },
  '/clients/{id}/assets': {
    post: { summary: 'Create an asset for a client', scope: 'write', body: assetSchema, created: true },
  },
  '/assets': {
    get: {
      summary: 'List assets',
      scope: 'read',
      query: { client: 'Client ID', layout: 'Layout ID', archived: 'true for archived assets' },
    },
  },
  '/assets/{id}': {
    get: { summary: 'Get an asset', scope: 'read' },
    patch: { summary: 'Update an asset (send the current version)', scope: 'write', body: updateAssetSchema },
  },
  '/layouts': { get: { summary: 'List asset layouts and their fields', scope: 'read' } },
  '/documents': {
    get: {
      summary: 'List documents',
      scope: 'read',
      query: { client: 'Client ID, or "global" for the knowledge base', folder: 'Folder ID' },
    },
    post: { summary: 'Create a document', scope: 'write', body: createDocumentSchema, created: true },
  },
  '/documents/{id}': {
    get: { summary: 'Get a document with its content', scope: 'read' },
    patch: { summary: 'Update a document (send the current version)', scope: 'write', body: updateDocumentSchema },
  },
  '/clients/{id}/contacts': {
    get: { summary: "List a client's contacts", scope: 'read' },
    post: { summary: 'Add a contact', scope: 'write', body: contactSchema, created: true },
  },
  '/clients/{id}/locations': {
    get: { summary: "List a client's locations", scope: 'read' },
    post: { summary: 'Add a location', scope: 'write', body: locationSchema, created: true },
  },
  '/items/{type}/{id}/relations': {
    get: { summary: 'List related items', scope: 'read' },
    post: { summary: 'Link two items in the same client', scope: 'write', body: relationSchema, created: true },
  },
  '/search': { get: { summary: 'Search everything you can access', scope: 'read', query: { q: 'Search text' } } },
  '/activity': {
    get: { summary: 'Recent changes', scope: 'read', query: { client: 'Client ID', limit: 'Up to 200' } },
  },
  '/expirations': { get: { summary: 'Items expiring or due soon', scope: 'read', query: { days: 'Window, 1–730' } } },
  '/passwords': {
    get: { summary: 'List password entries (no secrets)', scope: 'passwords', query: { client: 'Client ID' } },
  },
  '/clients/{id}/passwords': {
    post: { summary: 'Add a password entry', scope: 'passwords', body: createPasswordSchema, created: true },
  },
  '/passwords/{id}': {
    get: { summary: 'Get a password entry (no secret)', scope: 'passwords' },
    patch: { summary: 'Update a password entry', scope: 'passwords', body: updatePasswordSchema },
  },
  '/passwords/{id}/reveal': {
    post: { summary: 'Reveal a secret (audited)', scope: 'passwords', body: revealSchema },
  },
};

/** OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json. */
export function openApiSpec(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, ops] of Object.entries(PATHS)) {
    paths[path] = {};
    const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) =>
      m[1] === 'type'
        ? {
            name: 'type',
            in: 'path',
            required: true,
            schema: { enum: ['asset', 'document', 'contact', 'location', 'password'] },
          }
        : idParam(m[1]!),
    );
    for (const [method, op] of Object.entries(ops)) {
      paths[path]![method] = {
        summary: op.summary,
        description: `Needs the "${op.scope === 'passwords' ? 'passwords' : op.scope}" scope${op.scope === 'passwords' ? ' (plus "read" or "write")' : ''}.`,
        parameters: [
          ...params,
          ...Object.entries(op.query ?? {}).map(([name, description]) => ({
            name,
            in: 'query',
            required: name === 'q',
            description,
            schema: { type: 'string' },
          })),
        ],
        ...(op.body
          ? { requestBody: { required: true, content: { 'application/json': { schema: json(op.body) } } } }
          : {}),
        responses: {
          [op.created ? '201' : '200']: { description: 'OK', content: { 'application/json': { schema: {} } } },
          '400': { $ref: '#/components/responses/Error' },
          '401': { $ref: '#/components/responses/Error' },
          '403': { $ref: '#/components/responses/Error' },
          '404': { $ref: '#/components/responses/Error' },
          '429': { $ref: '#/components/responses/Error' },
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'MSP Atlas API',
      version: '1',
      description:
        'Authenticate with an API key from Settings → API keys: `Authorization: Bearer atlas_…`. A key acts as the administrator who created it, limited by its scopes. Limit: 600 requests a minute per key.',
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'atlas_<prefix>_<secret>' } },
      responses: {
        Error: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { error: { type: 'string' }, code: { type: 'string' }, fields: { type: 'object' } },
                required: ['error'],
              },
            },
          },
        },
      },
    },
    paths,
  };
}
