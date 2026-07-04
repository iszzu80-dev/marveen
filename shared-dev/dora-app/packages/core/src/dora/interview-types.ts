export type InterviewMode = 'eligibility' | 'system_scope';
export type InterviewStatus = 'in_progress' | 'completed' | 'abandoned';
export type QuestionType = 'yes_no' | 'single_choice' | 'multi_choice' | 'text';
export type SecurityClass = 'Alap' | 'Jelentős' | 'Magas';

export interface InterviewQuestion {
  id: string;
  text: string;
  hint?: string;
  type: QuestionType;
  options?: QuestionOption[];
  defaultNextId?: string;
  terminal?: true;
}

export interface QuestionOption {
  value: string;
  label: string;
  nextId?: string;
  terminatesWith?: InterviewOutcome;
}

export interface InterviewOutcome {
  inScope: boolean;
  securityClass?: SecurityClass;
  reasoning: string;
  nextMode?: InterviewMode;
  suggestedEirTypes?: string[];
}

export interface InterviewAnswer {
  questionId: string;
  value: string | string[];
  answeredAt: string;
}

export interface InterviewSession {
  id: string;
  tenantId: string;
  mode: InterviewMode;
  status: InterviewStatus;
  currentQuestionId: string;
  answers: InterviewAnswer[];
  outcome?: InterviewOutcome;
  createdAt: string;
  completedAt?: string;
}
