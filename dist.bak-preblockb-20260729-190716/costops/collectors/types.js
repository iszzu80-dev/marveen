// CostOps v0.3 -- provider cost collector framework (types).
//
// Provider-agnostic, deterministic, NO LLM. The HTTP fetcher is INJECTED so
// collectors are unit-tested fully offline with fixtures -- no live provider
// call happens unless a real fetcher is passed in by an explicitly-approved run.
// Secrets are passed in by the runner (from the Vault) and are NEVER logged.
export {};
