"use client";

import { createContext, useContext } from "react";

/**
 * Whether customer billing pages are on (setting customerBilling). Provided by AppShell so client
 * components in the dashboard (e.g. the playground's "Add funds" button) can hide billing links.
 */
const CustomerBillingContext = createContext(true);

export const CustomerBillingProvider = CustomerBillingContext.Provider;

export function useCustomerBilling(): boolean {
  return useContext(CustomerBillingContext);
}
