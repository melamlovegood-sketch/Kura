/// <reference types="@cloudflare/workers-types" />

import { handleAnalyzeImage } from '../../server/analyze-image'

export const onRequestPost: PagesFunction = (context) => handleAnalyzeImage(context.request)
