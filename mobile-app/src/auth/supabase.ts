import 'react-native-url-polyfill/auto';

import { createPinkevaSupabaseClient } from './createSupabaseClient';
import { secureSessionStorage } from './secureSessionStorage';

export const supabase = createPinkevaSupabaseClient(secureSessionStorage);
