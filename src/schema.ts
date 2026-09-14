import { z } from "zod";

export const diagnosisSchema = z.object({
  project_stage: z.string().trim().min(2).max(80),
  observed_problem: z.string().trim().min(10).max(2000),
  concerning_behaviour: z.string().trim().min(2).max(120),
  inspection_surfaces: z.array(z.string().trim().min(1).max(40)).min(1).max(6),
  inspection_details: z.string().trim().min(3).max(2000),
  ninety_day_consequence: z.string().trim().min(10).max(2000),
  contact_name: z.string().trim().min(2).max(120),
  contact_role: z.string().trim().min(2).max(120),
  contact_method: z.string().trim().min(3).max(255),
});

export type DiagnosisSubmission = z.infer<typeof diagnosisSchema>;
