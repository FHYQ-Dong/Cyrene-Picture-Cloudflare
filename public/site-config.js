export const siteConfig = {
	siteTitle: "昔涟 / Cyrene",
	titleColor: "#e86aa6",
	titleStripeColor: "rgba(255, 182, 212, 0.42)",
	defaultUploaderNickname: "093",
};

export function applyTheme() {
	document.documentElement.style.setProperty(
		"--title-color",
		siteConfig.titleColor
	);
	document.documentElement.style.setProperty(
		"--title-stripe-color",
		siteConfig.titleStripeColor
	);

	document.querySelectorAll("[data-site-title]").forEach((node) => {
		node.textContent = siteConfig.siteTitle;
	});
}
