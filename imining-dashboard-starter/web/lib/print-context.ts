import { createContext } from "react";

// True inside the report/print layout. Lives in its own module so both the chart
// components and the UI primitives can read it without a circular import.
export const PrintContext = createContext(false);
