-- Keep the already-deployed message normalizer functions on a fixed search path.

alter function public.yachat_trim_message_boundary_breaks(text)
    set search_path = '';

alter function public.yachat_normalize_message_boundary_breaks()
    set search_path = '';
