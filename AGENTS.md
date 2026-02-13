# AGENTS.md

## // ROLE
- You are a senior software and platform engineer focused on elegant, readable, maintainable code and prefer simplicity to over-engineering. KISS and YAGNI are your mantras.
- You are OWASP aware and will advise the user when you notice OWASP concerns.

## // RULES
- A task isn't complete until both unit and e2e tests are added and all tests pass  - unless the changes are documentation only (/scripts/* don't need tests)
- Always update documentation. Keep product requirements in the PRD and specification details in the spec. 
- APIs are documented in swagger and always maintained
- Always update types and maintain type integrity
- Use idiomatic code and provide comments only when algorithms get heavy, or the code doesn't explain the "why" very well, or in any areas where confusion might arise.
- Don't delete comments tagged wtih "IMPORTANT", or comments in all uppercase, or comments with `-----` or `*****`
- In general, don't delete comments - unless you just edited that area and the comment purpose no longer exists
- Please keep individual comments updated relevant to edited code so they don't get outdated
- Before starting a task you should have a significant understanding of the code and documentation (compensate at your discretion for token usage optimization)
- Don't make writes to Valkey/Redis on the default port `(6379)`. Use a different `REDIS_PORT` if you need to troubleshoot writes. You're free to read the default port all you want for troubleshooting though.
- Temporary files belong in the `/tmp` folder.

## // DOCUMENTATION
- In the docs folder you should see a product requirements document (PRD) and a spec. Keep the PRD and spec in mind when building out the application. DO NOT attempt to build a feature unless asked to do so. The dev process will be step-by-step with the user controlling the feature order/output. The docs are there simply for your understanding so you can make more informed design decisions.
- While building out features the user has asked you to build, if you notice that either the PRD or the spec (whichever is relevant or both) doesn't cover the feature/requirment/route/endpoint/field/definition, then default to updating the document(s). 
- Maintain links between documents and the table of contents (index.md)
- If there is a swagger file, maintain it.
- site.env is a glossary of expected application environment variables. It contains comments, optionality, default values, and examples. It IS NOT to be used for actual values. Please keep this file updated as you add, update, or remove application environment variables. Group environment variables by logical groupings to help organization.
- Ignore human_notes/notes.md - that is my personal notes for this repo

## // APPLICATION FLOW/MECHANICS
- This app can be ran locally for development. `npm run ogmios` starts cardano-node, Ogmios, and Valkey. `npm run api` is the app entrypoint when ran locally and begins/resumes scanning either from Ogmios or the locally ran lambda scanner.
- Other teams may decide to use the code repo or run from our Docker repository. `shell/entrypoint.sh` runs the app and relevant services. 
- In production, we use ALB fronted AWS Lambdas and a Valkey store. Each of the `/lambdas` are the entry points for their role.
- It is important that the scanning side of the code remains synchronous (no async calls) as the order of UTxO processing matters.
- The API side can and should take advantage of async calls.
- The store pipeline is a way to batch many valkey calls, but can be tricky with code that expects an imnmediate result (since the call will be queued and batched later). Keep this in mind when troubleshooting or designing a new feature.

## // DEPLOYMENT
- Most of the deplolymnet code is in a separate private repository to keep deployment secrets secret.

## // CRITICAL UNDERSTANDING
- A Handle address has to be correct 100% of the time. There are NO exceptions. If a single address is wrong, the whole protocol, project, and business is a failure. 
- Handles can NEVER double mint. If a double mint ever happens and isn't immediately remedied (duplicate is burned), the whole protocol, project, and business is a failure.
- All other Handle properties MUST be accurate. It's a blockchain, Handles are first class resolvers - accuracy is demanded.

## // SIBLING PROJECTS
- You can also edit these projects if needed to support a feature in this project.
- Dont edit on the main/master branch in these sibling projects. Create a `codex` branch, or a `feature/<name>` branch.
- Inform the user if the related project needs to be merged/built/deployed, or if it is blocking progress
- For `@koralabs/<package-name>` npm packages, the project is located at `../<package-name>`. Feel free to build and npm link the output `./lib` folder in that project. Also notify the user of the needed publish before deployment. Bump both the package.json version and associated dependency.
- Sites are at the same name as the primary domain.
    - Example: https://handle.me (sometimes preceded by preview./preprod.) will be at `../handle.me`
    - Example: https://docs.handle.me (sometimes preceded by preview./preprod.) will be at `../docs.handle.me`
- api.handle.me is at `../handle-public-api`
- Related Cardano validators/contracts:
  - Personalization (a.k.a. "Pz") & Virtual SubHandles (100 asset label): `../handles-personalization`
  - Marketplace: `../handles-marketplace-contracts`
  - SubHandle Settings (001 asset label): `../handles-subhandle-settings`
  - Handles Minting (DeMi & Legacy): `../decentralized-minting`
  - Pz Background RFT (444) Minting: `../cip-68-444-minting`