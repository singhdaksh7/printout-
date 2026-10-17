import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Default findBy/waitFor timeout is 1000 ms, too tight for full-page renders on a loaded machine (see vite.config.ts).
configure({ asyncUtilTimeout: 5000 });
