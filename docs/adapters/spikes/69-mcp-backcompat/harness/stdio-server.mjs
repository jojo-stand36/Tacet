import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { factory } from './factory.mjs';
serveStdio(factory, process.env.LEGACY ? { legacy: process.env.LEGACY } : undefined);
