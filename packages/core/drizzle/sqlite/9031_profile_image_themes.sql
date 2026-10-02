-- Free-text theme label per gallery image. Null means unlabeled. A teammate
-- restricts every photo surface to one theme via custom_context.teammate
-- .activePhotoTheme; the label itself lives here so it follows the image.
ALTER TABLE `profile_images` ADD `theme` text;
