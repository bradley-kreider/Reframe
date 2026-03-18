# Reframe - See What Matters

**Version 1.0 | February 2, 2026**

## Section 1. Functional Requirements

**FR-01** - The software shall operate on browsers that support HTML-5.

**FR-01a** - The backend shall have access to read and modify the Document Object Model (DOM) via the browser.

**FR-02** - The software shall store/fetch content preferences on a local database.

**FR-02a** - Content preferences shall consist of keywords, topics, and info sources.

**FR-03** - The software shall provide a user interface to allow users to add, remove, and edit their content preferences at will.

**FR-04** - The software shall have access to a local, light GPT model.

**FR-04a** - The light GPT model shall have access to the internet.

**FR-05** - The software shall detect user-specified blacklisted content.

**FR-06** - The software shall replace blacklisted content with GPT-selected whitelisted content specified by the user.

## Section 2. Non-Functional Requirements

**NFR-01** - The light GPT model shall not consume more than 10 Watts of electricity from the system's power supply.

**NFR-02** - The software shall require at least 8GB of RAM on an operating system to run.

**NFR-03** - The software shall not consume more than 80% of available CPU.

**NFR-04** - The software shall not delay the expected page load time by more than 1.3 seconds.

**NFR-05** - The software shall not recommend content outside of user selection (whitelisted by user) when replacing blacklisted content.

**NFR-06** - The software shall generate revenue by placing "personalized ads" based on user content preferences on webpages.
