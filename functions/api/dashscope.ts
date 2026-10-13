/// <reference types="@cloudflare/workers-types" />

import { handleDashscope } from '../../server/dashscope'

export const onRequestPost: PagesFunction = (context) => handleDashscope(context.request)
