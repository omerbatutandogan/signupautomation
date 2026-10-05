/**
 * Ürün profili şeması — web panelindeki ürün editörü ve işçi aynı şemayla
 * doğrular. Yanlış bir profil 200 siteye aynı yanlışı yayar; hata kayıt
 * sırasında değil, KAYDEDERKEN yakalanmalı.
 */

import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const ProfileSchema = z.object({
  companyName: nonEmpty,
  legalName: nonEmpty,
  website: z.string().url(),
  tagline: nonEmpty,
  descriptions: z.object({
    short: nonEmpty,
    medium: nonEmpty,
    long: nonEmpty,
  }),
  category: z.object({
    primary: nonEmpty,
    aliases: z.array(nonEmpty),
  }),
  logo: z.record(z.string()),
  contact: z.object({
    firstName: nonEmpty,
    lastName: nonEmpty,
    role: nonEmpty,
    email: z.string().email(),
  }),
  socials: z.object({
    twitter: z.string().optional(),
    linkedin: z.string().optional(),
    github: z.string().optional(),
  }),
  pricing: nonEmpty,
  foundedYear: z.number().int(),
  signupEmail: z.string().email().optional(),
});

export type ProductProfile = z.infer<typeof ProfileSchema>;
